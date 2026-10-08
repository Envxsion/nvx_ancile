/**
 * ------------------------------------------------------------------
 *  Title    |  Restart adapters
 *  Ref      |  DESIGN.md §7.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  How the supervisor (and Restart on the health page)
 *           |  brings a service back.
 *  How      |  none     notify only
 *           |  process  the native runner (scripts/boot.mjs) that
 *           |           started the services: it listens on loopback
 *           |           with a one-off token and respawns the child
 *           |           (or Postgres) on request. `pnpm start` sets
 *           |           this up by default.
 *           |  docker   the Engine API over the Docker socket
 *           |           (/var/run/docker.sock, or the npipe on
 *           |           Windows): POST /containers/{name}/restart.
 *           |           Opt-in, because the socket is a privilege.
 *  Note     |  Core never restarts itself: the runner (or Docker's
 *           |  restart policy) does that when it exits.
 * ------------------------------------------------------------------
 */

import { request } from 'node:http';

export type RestartKind = 'none' | 'process' | 'docker';

export interface RestartAdapter {
  readonly kind: RestartKind;
  canRestart(service: string): boolean;
  restart(service: string): Promise<void>;
}

export const noneAdapter: RestartAdapter = {
  kind: 'none',
  canRestart: () => false,
  restart: async (service) => {
    throw new Error(`Automatic restart is off. Restart ${service} yourself, or set ANCILE_RESTART_ADAPTER.`);
  },
};

/** Services the native runner can bring back. */
export const PROCESS_RESTARTABLE = ['knowledge', 'controller', 'agent', 'postgres'] as const;

export function processAdapter(
  control: { url: string; token: string } | null,
  fetcher: typeof fetch = fetch,
): RestartAdapter {
  return {
    kind: 'process',
    canRestart: (s) => !!control && (PROCESS_RESTARTABLE as readonly string[]).includes(s),
    restart: async (service) => {
      if (!control)
        throw new Error(
          `${service} cannot be restarted from here: Core was not started by \`pnpm start\`. Restart it yourself.`,
        );
      const res = await fetcher(`${control.url}/restart/${encodeURIComponent(service)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${control.token}` },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `The runner could not restart ${service} (${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`,
        );
      }
    },
  };
}

export function dockerSocketPath(host = process.env.DOCKER_HOST): string {
  if (host?.startsWith('unix://')) return host.slice('unix://'.length);
  // npipe:////./pipe/docker_engine → \.\pipe\docker_engine
  if (host?.startsWith('npipe://')) return `\\.pipe\${host.split('/').pop() ?? 'docker_engine'}`;
  return process.platform === 'win32' ? '\\.pipedocker_engine' : '/var/run/docker.sock';
}

/** Container names by service; ANCILE_DOCKER_PREFIX matches your compose project. */
export function dockerContainers(
  prefix = process.env.ANCILE_DOCKER_PREFIX ?? 'nvx-ancile-',
): Record<string, string> {
  return {
    knowledge: `${prefix}knowledge-1`,
    controller: `${prefix}controller-1`,
    agent: `${prefix}agent-1`,
    postgres: `${prefix}postgres-1`,
  };
}

/** POST to the Engine API over its socket; resolves with the status code and body. */
function engine(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', timeout: 60_000 }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('the Docker engine did not answer within 60 s')));
    req.on('error', reject);
    req.end();
  });
}

export function dockerAdapter(
  socketPath = dockerSocketPath(),
  containers = dockerContainers(),
  call: typeof engine = engine,
): RestartAdapter {
  return {
    kind: 'docker',
    canRestart: (s) => s in containers,
    restart: async (service) => {
      const name = containers[service];
      if (!name) throw new Error(`No container is set for ${service}.`);
      let res: { status: number; body: string };
      try {
        // t=10: ten seconds to stop cleanly before it is killed.
        res = await call(socketPath, `/containers/${encodeURIComponent(name)}/restart?t=10`);
      } catch (err) {
        throw new Error(
          `Could not reach Docker at ${socketPath} (${(err as Error).message}). Is the socket mounted into Core?`,
        );
      }
      if (res.status === 404)
        throw new Error(`Docker has no container called ${name}. Set ANCILE_DOCKER_PREFIX.`);
      if (res.status >= 300) {
        let message = res.body;
        try {
          message = (JSON.parse(res.body) as { message?: string }).message ?? res.body;
        } catch {
          /* plain text */
        }
        throw new Error(`Docker could not restart ${name}: ${message.slice(0, 300)}`);
      }
    },
  };
}

export function restartAdapterFor(
  kind: RestartKind,
  control: { url: string; token: string } | null = null,
): RestartAdapter {
  return kind === 'docker' ? dockerAdapter() : kind === 'process' ? processAdapter(control) : noneAdapter;
}
