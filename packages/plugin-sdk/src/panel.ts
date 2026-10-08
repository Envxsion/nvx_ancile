/**
 * ------------------------------------------------------------------
 *  Title    |  Panel bridge
 *  Ref      |  DESIGN.md §12 (UI panels)
 *  ID       |  plugin-sdk
 * ------------------------------------------------------------------
 *  Purpose  |  Plugin panels run in a sandboxed iframe and talk to the
 *           |  Cockpit only through this postMessage protocol, limited
 *           |  to the capabilities declared in config/panels.yaml.
 *  How      |  Request/response with ids; the host replies with either
 *           |  a result or an error. The host also pushes `context`
 *           |  (current thread, theme) whenever it changes, so a panel
 *           |  can follow the light/dark switch.
 * ------------------------------------------------------------------
 */

export const PANEL_PROTOCOL = 'ancile.panel/1';

export type PanelCapability = 'read:thread' | 'read:sources' | 'read:memory' | 'write:notes' | 'invoke:tools';

export type PanelRequest =
  | { kind: 'thread.get' }
  | { kind: 'sources.list'; notebookId?: string }
  | { kind: 'memory.read'; path: string }
  | { kind: 'note.create'; notebookId: string; title: string; content: string }
  | { kind: 'tool.invoke'; tool: string; args: unknown };

export const REQUIRED_CAPABILITY: Record<PanelRequest['kind'], PanelCapability> = {
  'thread.get': 'read:thread',
  'sources.list': 'read:sources',
  'memory.read': 'read:memory',
  'note.create': 'write:notes',
  'tool.invoke': 'invoke:tools',
};

export interface PanelContext {
  theme: 'dark' | 'light';
  threadId: string | null;
  notebookId: string | null;
}

export type HostMessage =
  | { protocol: typeof PANEL_PROTOCOL; type: 'response'; id: string; ok: true; result: unknown }
  | {
      protocol: typeof PANEL_PROTOCOL;
      type: 'response';
      id: string;
      ok: false;
      error: { code: string; message: string };
    }
  | { protocol: typeof PANEL_PROTOCOL; type: 'context'; context: PanelContext };

export type PanelMessage = {
  protocol: typeof PANEL_PROTOCOL;
  type: 'request';
  id: string;
  request: PanelRequest;
};

/** The client a panel uses from inside its iframe. */
export function createPanelClient(target: Window = window.parent, self: Window = window) {
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(c: PanelContext) => void>();

  self.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as HostMessage | undefined;
    if (!msg || msg.protocol !== PANEL_PROTOCOL || ev.source !== target) return;
    if (msg.type === 'context') {
      for (const l of listeners) l(msg.context);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
  });

  return {
    request<T = unknown>(request: PanelRequest): Promise<T> {
      const id = `p${++seq}`;
      const message: PanelMessage = { protocol: PANEL_PROTOCOL, type: 'request', id, request };
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        // The host origin is opaque to a sandboxed frame; the host validates the source window.
        target.postMessage(message, '*');
      });
    },
    onContext(fn: (c: PanelContext) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
