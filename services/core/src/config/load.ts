/**
 * ------------------------------------------------------------------
 *  Title    |  Configuration loader
 *  Ref      |  DESIGN.md §12, config/*.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read every file in config/, validate it against the
 *           |  contracts, and report problems as file → key → message
 *           |  so a person editing YAML by hand is told exactly where.
 *  How      |  Missing optional files fall back to defaults; missing
 *           |  required ones (models, routing) are errors. The wizard
 *           |  writes the same files through writeConfig()
 *           |  (TODO(phase-2)).
 * ------------------------------------------------------------------
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AutomationsFile,
  FactcheckFile,
  McpFile,
  MemoryFile,
  ModelsFile,
  PanelsFile,
  RoutingFile,
  ToolsFile,
} from '@nvx/contracts';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

const FILES = {
  models: { file: 'models.yaml', schema: ModelsFile, required: true },
  routing: { file: 'routing.yaml', schema: RoutingFile, required: true },
  tools: { file: 'tools.yaml', schema: ToolsFile, required: false },
  memory: { file: 'memory.yaml', schema: MemoryFile, required: true },
  mcp: { file: 'mcp.yaml', schema: McpFile, required: false },
  panels: { file: 'panels.yaml', schema: PanelsFile, required: false },
  automations: { file: 'automations.yaml', schema: AutomationsFile, required: false },
  factcheck: { file: 'factcheck.yaml', schema: FactcheckFile, required: false },
} as const;

type Files = typeof FILES;
export type AncileConfig = { [K in keyof Files]: z.infer<Files[K]['schema']> | null } & {
  policies: Record<string, string>;
};

export interface ConfigProblem {
  file: string;
  key: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: ConfigProblem[]) {
    super(
      ['Configuration is not valid:', ...problems.map((p) => `  ${p.file} → ${p.key}: ${p.message}`)].join(
        '\n',
      ),
    );
    this.name = 'ConfigError';
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadConfig(dir: string): Promise<AncileConfig> {
  const problems: ConfigProblem[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(FILES)) {
    const text = await readIfExists(join(dir, spec.file));
    if (text === null) {
      if (spec.required)
        problems.push({
          file: spec.file,
          key: '(file)',
          message: `missing from ${dir}; run onboarding or copy it from the repository's config/`,
        });
      out[name] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      problems.push({
        file: spec.file,
        key: '(yaml)',
        message: (err as Error).message.split('\n')[0] ?? 'invalid YAML',
      });
      out[name] = null;
      continue;
    }
    const parsed = (spec.schema as z.ZodTypeAny).safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        problems.push({ file: spec.file, key: i.path.join('.') || '(root)', message: i.message });
      out[name] = null;
    } else out[name] = parsed.data;
  }

  const policies: Record<string, string> = {};
  try {
    for (const f of await readdir(join(dir, 'policies'))) {
      if (f.endsWith('.cedar')) policies[f] = await readFile(join(dir, 'policies', f), 'utf8');
    }
  } catch {
    /* no policies directory: the built-in policy applies */
  }

  // Cross-file checks: routing may only name models that exist.
  const models = out.models as z.infer<typeof ModelsFile> | null;
  const routing = out.routing as z.infer<typeof RoutingFile> | null;
  if (models && routing) {
    const known = new Set(models.models.map((m) => m.id));
    for (const [tc, spec] of Object.entries(routing.task_classes)) {
      const ids = Array.isArray(spec) ? spec : spec.chain;
      for (const id of ids) {
        if (!known.has(id) && !id.startsWith('local/')) {
          problems.push({
            file: 'routing.yaml',
            key: `task_classes.${tc}`,
            message: `"${id}" is not defined in models.yaml`,
          });
        }
      }
    }
  }

  if (problems.length) throw new ConfigError(problems);
  return { ...(out as Omit<AncileConfig, 'policies'>), policies };
}
