/**
 * ------------------------------------------------------------------
 *  Title    |  JSON Schema export
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Every zod schema in this package as JSON Schema, for
 *           |  code outside TypeScript: Knowledge's Python models and
 *           |  the nvx.sh server ports (telemetry, licence, sync).
 *  How      |  pnpm --filter @nvx/contracts export:jsonschema
 *           |  → packages/contracts/dist/jsonschema/<module>.json, one
 *           |  file per module, each schema under its export name.
 *  Note     |  What JSON Schema cannot say (transforms, custom checks)
 *           |  is written as the input shape and listed as a warning.
 * ------------------------------------------------------------------
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const SRC = join(import.meta.dirname, '..', 'src');
const OUT = join(import.meta.dirname, '..', 'dist', 'jsonschema');

const isSchema = (v: unknown): v is z.ZodType => v instanceof z.ZodType;

async function main() {
  mkdirSync(OUT, { recursive: true });
  let total = 0;
  const warnings: string[] = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
    const mod = (await import(pathToFileURL(join(SRC, file)).href)) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(mod)) {
      if (!isSchema(value)) continue;
      try {
        out[name] = z.toJSONSchema(value, { io: 'input', unrepresentable: 'any' });
        total++;
      } catch (err) {
        warnings.push(`${file} ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (Object.keys(out).length === 0) continue;
    const name = file.replace(/\.ts$/, '');
    writeFileSync(
      join(OUT, `${name}.json`),
      `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: `@nvx/contracts/${name}`, $defs: out }, null, 2)}\n`,
    );
  }
  console.log(`Exported ${total} schemas to ${OUT}`);
  for (const w of warnings) console.warn(`  skipped ${w}`);
}

void main();
