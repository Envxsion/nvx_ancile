/**
 * ------------------------------------------------------------------
 *  Title    |  vLLM defaults for small GPUs
 *  Ref      |  infra/node/vllm-defaults.sh
 *  ID       |  controller/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live on an RTX 3060: vLLM's default 0.90 memory
 *           |  and CUDA graphs left no room and it failed at start, and
 *           |  cached tokens were never reported. The node script adds
 *           |  headroom on 12 GB or less, --enforce-eager there, and
 *           |  --enable-prompt-tokens-details, unless already set.
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NODE_DIR = join(__dirname, '..', '..', '..', '..', 'infra', 'node');
const script = join(NODE_DIR, 'vllm-defaults.sh').replace(/\\/g, '/');

function hasBash(): boolean {
  try {
    execFileSync('bash', ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
}

const defaults = (mib: number, args: string) =>
  execFileSync('bash', ['-c', 'source "$0"; vllm_default_args "$1" "$2"', script, String(mib), args], {
    encoding: 'utf8',
  }).trim();

describe.runIf(hasBash())('vLLM defaults', () => {
  it('give a small GPU headroom and eager mode, and always report cached tokens', () => {
    expect(defaults(8_192, '')).toBe(
      '--enable-prompt-tokens-details --gpu-memory-utilization 0.80 --enforce-eager',
    );
    expect(defaults(12_288, '--max-model-len 8192')).toBe(
      '--enable-prompt-tokens-details --gpu-memory-utilization 0.85 --enforce-eager',
    );
    expect(defaults(24_576, '')).toBe('--enable-prompt-tokens-details');
    expect(defaults(0, '')).toBe('--enable-prompt-tokens-details');
  });

  it('never override what the node was asked for', () => {
    expect(
      defaults(10_240, '--gpu-memory-utilization 0.7 --enforce-eager --enable-prompt-tokens-details'),
    ).toBe('');
  });
});

describe('the node status page', () => {
  it('shows the first error lines and the last 80 of vLLM’s log', () => {
    const boot = readFileSync(join(NODE_DIR, 'bootstrap.sh'), 'utf8');
    expect(boot).toContain('first error lines');
    expect(boot).toContain('tail -n 80 "$LOG_DIR/vllm.log"');
    expect(boot).toContain('$DEFAULT_ARGS $ANCILE_VLLM_ARGS');
  });
});

describe('the node script piped into bash (curl … | bash)', () => {
  it('fetches every helper it uses, since a piped run has nothing beside it', () => {
    const boot = readFileSync(join(NODE_DIR, 'bootstrap.sh'), 'utf8');
    const used = new Set([...boot.matchAll(/\$HERE\/([\w.-]+\.sh)/g)].map((m) => m[1]));
    const fetched = new Set((/^HELPERS="([^"]+)"/m.exec(boot)?.[1] ?? '').split(/\s+/));
    expect(used.size).toBeGreaterThan(0);
    for (const f of used) expect(fetched, `${f} is used but not fetched`).toContain(f);
  });
});
