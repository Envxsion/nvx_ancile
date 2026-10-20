/**
 * The configuration loader (config/load.ts): the shipped config/ loads and
 * validates; a missing required file, broken YAML, a value the contracts
 * refuse and a routing chain naming an unknown model are each reported as
 * file → key → message, all at once.
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { ConfigError, loadConfig } from '../../src/config/load';

const CONFIG = join(import.meta.dirname, '../../../../config');

async function problemsOf(dir: string) {
  const err = await loadConfig(dir).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConfigError);
  return (err as ConfigError).problems;
}

async function copyOf(...files: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'ancile-config-'));
  for (const f of files) await copyFile(join(CONFIG, f), join(dir, f));
  return dir;
}

describe('loadConfig', () => {
  it('loads the shipped configuration, with its policies', async () => {
    const cfg = await loadConfig(CONFIG);
    expect(cfg.models?.models.length).toBeGreaterThan(0);
    expect(cfg.routing).not.toBeNull();
    expect(Object.keys(cfg.policies).some((f) => f.endsWith('.cedar'))).toBe(true);
  });

  it('names every missing required file, and optional ones are simply absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ancile-config-'));
    const problems = await problemsOf(dir);
    expect(problems.map((p) => [p.file, p.key])).toEqual([
      ['models.yaml', '(file)'],
      ['routing.yaml', '(file)'],
      ['memory.yaml', '(file)'],
    ]);
    expect(problems[0]?.message).toContain('run onboarding');
  });

  it('reports broken YAML and refused values by file and key', async () => {
    const dir = await copyOf('models.yaml', 'routing.yaml', 'memory.yaml');
    await writeFile(join(dir, 'tools.yaml'), 'tools: [unclosed\n');
    await writeFile(join(dir, 'mcp.yaml'), stringify({ servers: 'not a list' }));
    const problems = await problemsOf(dir);
    expect(problems.find((p) => p.file === 'tools.yaml')?.key).toBe('(yaml)');
    expect(problems.some((p) => p.file === 'mcp.yaml' && p.key !== '(yaml)')).toBe(true);
  });

  it('refuses a routing chain that names a model models.yaml does not define', async () => {
    const dir = await copyOf('models.yaml', 'memory.yaml');
    const routing = parse(await readFile(join(CONFIG, 'routing.yaml'), 'utf8')) as {
      task_classes: Record<string, string[] | { chain: string[] }>;
    };
    const [first] = Object.keys(routing.task_classes);
    const spec = routing.task_classes[first as string];
    if (Array.isArray(spec)) spec.unshift('ghost/model');
    else if (spec) spec.chain.unshift('ghost/model');
    await writeFile(join(dir, 'routing.yaml'), stringify(routing));
    await mkdir(join(dir, 'policies'));
    const problems = await problemsOf(dir);
    expect(problems).toContainEqual({
      file: 'routing.yaml',
      key: `task_classes.${first}`,
      message: '"ghost/model" is not defined in models.yaml',
    });
  });

  it('accepts a :latest alias when a model in models.yaml belongs to that line, and refuses one that none does', async () => {
    const dir = await copyOf('models.yaml', 'memory.yaml');
    const routing = parse(await readFile(join(CONFIG, 'routing.yaml'), 'utf8')) as {
      task_classes: Record<string, string[] | { chain: string[] }>;
    };
    expect(JSON.stringify(routing)).toContain('anthropic/sonnet:latest');
    routing.task_classes['chat.default'] = ['anthropic/opus:latest', 'anthropic/mythos:latest'];
    await writeFile(join(dir, 'routing.yaml'), stringify(routing));
    await mkdir(join(dir, 'policies'));
    const problems = await problemsOf(dir);
    expect(problems).toEqual([
      {
        file: 'routing.yaml',
        key: 'task_classes.chat.default',
        message: '"anthropic/mythos:latest" points at a line that no model in models.yaml belongs to',
      },
    ]);
  });
});
