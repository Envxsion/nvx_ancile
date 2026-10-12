/**
 * ------------------------------------------------------------------
 *  Title    |  Local models: this computer, and what fits on it
 *  Ref      |  docs/models.md (Download a local model)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say plainly, before a long download, whether a model
 *           |  will run here: on the graphics card, slowly on the
 *           |  processor, or not at all, and whether the disk has room.
 *  How      |  Memory from the operating system. A graphics card from
 *           |  nvidia-smi when it is installed (the card with the most
 *           |  memory), or Apple silicon's shared memory. Free disk
 *           |  where Ollama keeps models (OLLAMA_MODELS, else ~/.ollama),
 *           |  read with system/disk.ts. Each probe is short and may
 *           |  fail: an unknown is said as unknown, never guessed.
 *  Note     |  No network: nothing about this computer leaves it.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { homedir, arch as osArch, platform as osPlatform, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LocalFit, LocalHardware, LocalModelEntry } from '@nvx/contracts';
import { type DiskSpace, diskSpace, formatBytes } from '../system/disk';

const run = promisify(execFile);
const GB = 1024 ** 3;
/** Kept free beyond the download, as system/disk.ts does for its jobs. */
const DISK_RESERVE_GB = 0.25;
/** Of Apple silicon's shared memory, about this much can hold a model. */
const SHARED_GPU_SHARE = 0.7;

export interface HardwareProbe {
  platform: NodeJS.Platform;
  arch: string;
  totalmem: () => number;
  /** nvidia-smi's CSV (name, MiB), or null when it is not there. */
  nvidia: () => Promise<string | null>;
  disk: (path: string) => Promise<DiskSpace>;
}

export const realProbe: HardwareProbe = {
  platform: osPlatform(),
  arch: osArch(),
  totalmem,
  nvidia: async () => {
    try {
      const { stdout } = await run(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 3_000, windowsHide: true },
      );
      return stdout;
    } catch {
      return null;
    }
  },
  disk: (path) => diskSpace(path),
};

/** Where Ollama keeps models on this computer. */
export function ollamaModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models');
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The card with the most memory, from nvidia-smi's CSV. */
export function parseNvidia(csv: string | null): { name: string; vram_gb: number } | null {
  let best: { name: string; vram_gb: number } | null = null;
  for (const line of (csv ?? '').split(/\r?\n/)) {
    const i = line.lastIndexOf(',');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const mib = Number(line.slice(i + 1).trim());
    if (!name || !Number.isFinite(mib) || mib <= 0) continue;
    const gb = round1((mib * 1024 * 1024) / GB);
    if (!best || gb > best.vram_gb) best = { name, vram_gb: gb };
  }
  return best;
}

const OS: Record<string, LocalHardware['os']> = { win32: 'windows', darwin: 'macos', linux: 'linux' };

export async function detectHardware(opts: {
  /** Ollama runs here, so its disk is this computer's. */
  ollamaLocal: boolean;
  modelsDir: string;
  probe?: HardwareProbe;
}): Promise<LocalHardware> {
  const p = opts.probe ?? realProbe;
  const ram = round1(p.totalmem() / GB);
  let gpu: LocalHardware['gpu'] = null;
  if (p.platform === 'darwin' && p.arch === 'arm64')
    gpu = { name: 'Apple silicon', vram_gb: null, shared: true };
  else {
    const nv = parseNvidia(await p.nvidia().catch(() => null));
    if (nv) gpu = { name: nv.name, vram_gb: nv.vram_gb, shared: false };
  }
  let disk: DiskSpace | null = null;
  if (opts.ollamaLocal) disk = await p.disk(opts.modelsDir).catch(() => null);
  return {
    os: OS[p.platform] ?? 'other',
    ram_gb: ram,
    gpu,
    disk_free_gb: disk ? round1(disk.free / GB) : null,
    disk_where: disk ? disk.drive : null,
  };
}

const gb = (n: number) => `${n < 1 ? n.toFixed(2) : round1(n)} GB`;

/**
 * Will it fit? Disk first (a download that cannot finish is the worst
 * outcome), then memory: the graphics card, else the processor.
 */
export function fitOf(
  m: LocalModelEntry,
  hw: LocalHardware,
  opts: { installed: boolean; remote: boolean; platform?: NodeJS.Platform },
): LocalFit {
  if (opts.remote && m.via === 'ollama')
    return {
      verdict: 'unknown',
      reasons: ['Ollama runs on another computer, so its memory and disk cannot be checked from here.'],
      blocker: null,
    };
  const reasons: string[] = [];
  if (!opts.installed && hw.disk_free_gb !== null) {
    const need = m.size_gb * 1.1 + DISK_RESERVE_GB;
    if (hw.disk_free_gb < need) {
      const where =
        (opts.platform ?? process.platform) === 'win32'
          ? `drive ${hw.disk_where}`
          : (hw.disk_where ?? 'the disk');
      return {
        verdict: 'no',
        reasons: [
          `Needs about ${gb(need)} of disk; ${formatBytes(hw.disk_free_gb * GB)} free on ${where}. Free some space first.`,
        ],
        blocker: 'disk',
      };
    }
  }
  const card = hw.gpu?.shared ? round1(hw.ram_gb * SHARED_GPU_SHARE) : (hw.gpu?.vram_gb ?? null);
  if (m.vram_gb !== null && card !== null && card >= m.vram_gb) {
    reasons.push(
      hw.gpu?.shared
        ? `Fits in Apple silicon's shared memory (about ${gb(m.vram_gb)} of ${gb(hw.ram_gb)}).`
        : `Fits on your graphics card (${hw.gpu?.name}, ${gb(card)}; it needs about ${gb(m.vram_gb)}).`,
    );
    return { verdict: 'good', reasons, blocker: null };
  }
  if (hw.ram_gb >= m.ram_gb) {
    if (m.vram_gb === null) {
      reasons.push(`Needs about ${gb(m.ram_gb)} of memory; this computer has ${gb(hw.ram_gb)}.`);
      return { verdict: 'good', reasons, blocker: null };
    }
    reasons.push(
      card === null
        ? `No graphics card was found (there may still be one), so it would run on the processor: answers will be slow.`
        : `Too big for your graphics card (${gb(card)}; it needs about ${gb(m.vram_gb)}), so it would run mostly on the processor: answers will be slow.`,
    );
    reasons.push(`It needs about ${gb(m.ram_gb)} of memory; this computer has ${gb(hw.ram_gb)}.`);
    return { verdict: 'slow', reasons, blocker: null };
  }
  return {
    verdict: 'no',
    reasons: [
      `Needs about ${gb(m.ram_gb)} of memory${m.vram_gb !== null ? ` (or a graphics card with ${gb(m.vram_gb)})` : ''}; this computer has ${gb(hw.ram_gb)}. Pick a smaller model.`,
    ],
    blocker: 'memory',
  };
}
