/**
 * ------------------------------------------------------------------
 *  Title    |  Works with Claude Code: assembly
 *  Ref      |  docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Build the Claude Code feature from its parts for main.ts:
 *           |  the CLI, the installer, the install check, the bridge
 *           |  (started only when sessions are read), the read-only
 *           |  look at which Claude Code processes hold sessions, and
 *           |  the service.
 *  Note     |  Constructing it starts nothing; startAuto() does, and
 *           |  only when Claude Code is installed.
 * ------------------------------------------------------------------
 */

import { join } from 'node:path';
import type { EventBus } from '../events/bus';
import type { NotebookRepo } from '../notebooks/repo';
import type { SettingsStore } from '../settings';
import type { ThreadRepo } from '../threads/repo';
import { BridgeClient, processLauncher } from './bridge';
import { ClaudeCli } from './cli';
import { SessionHolders, systemLister } from './holders';
import { ClaudeInstaller } from './install';
import { ClaudeCodeService } from './service';
import type { ClaudeCodeStore } from './store';
import { ClaudeVerifier } from './verify';

export interface ClaudeCodeAssembly {
  service: ClaudeCodeService;
  bridge: BridgeClient;
  /** Claude Code processes outside NVX Ancile holding sessions (read-only). */
  holders: SessionHolders;
  /** The empty folder a thread that goes on without files runs in. */
  noFilesDir: string;
  stop(): void;
}

export function createClaudeCode(deps: {
  workspaceId: string;
  dataDir: string;
  logLevel: string;
  settings: SettingsStore;
  bus: EventBus;
  threads: ThreadRepo;
  notebooks: NotebookRepo;
  store: ClaudeCodeStore;
}): ClaudeCodeAssembly {
  let service: ClaudeCodeService | null = null;
  const cli = new ClaudeCli({ env: () => service?.cliEnv() ?? {} });
  const installer = new ClaudeInstaller({
    found: () => {
      cli.invalidate();
      return !!cli.where();
    },
    onChange: (state) => {
      void deps.bus
        .publish({ type: 'claude_code.changed', what: 'install', detail: state })
        .catch(() => undefined);
    },
  });
  const bridge = new BridgeClient({
    launch: processLauncher({ dataDir: join(deps.dataDir, 'claude-bridge'), logLevel: deps.logLevel }),
  });
  const holders = new SessionHolders({ lister: systemLister() });
  service = new ClaudeCodeService({
    holders,
    workspaceId: deps.workspaceId,
    settings: deps.settings,
    bus: deps.bus,
    threads: deps.threads,
    notebooks: deps.notebooks,
    store: deps.store,
    source: bridge,
    cli,
    installer,
    verifier: new ClaudeVerifier(),
  });
  const svc = service;
  return {
    service: svc,
    bridge,
    holders,
    noFilesDir: join(deps.dataDir, 'claude-code', 'no-folder'),
    stop: () => {
      svc.stop();
      bridge.stop();
    },
  };
}
