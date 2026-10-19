/**
 * ------------------------------------------------------------------
 *  Title    |  Error boundary
 *  Ref      |  ROADMAP ER1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One failing panel, route, message, artifact, flow node
 *           |  or lazy chunk must not take the window down. The
 *           |  fallback keeps the rest working and says what to do.
 *  How      |  A class boundary per scope. "Reload this panel" mounts
 *           |  the children again; if they fail a second time the
 *           |  boundary hands the error to the one above (never a
 *           |  loop). A chunk that failed to load offers "Try again",
 *           |  and lazyHost re-requests it. The shell scope offers
 *           |  Reload and "Start in safe mode" (?safe=1).
 *           |  The full card (icon, Copy debug info, Report) is its own
 *           |  chunk, ErrorFallback.tsx, fetched when something breaks;
 *           |  a plain card of the same shape stands in until it arrives.
 *  Note     |  The catch is logged to the console with the version.
 *           |  TODO(phase-5): send it to Core's log with the trace id
 *           |  once Core takes client errors.
 * ------------------------------------------------------------------
 */

import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { COCKPIT_VERSION } from '../lib/build';
import type { FallbackProps } from './ErrorFallback';

export type BoundaryScope = 'shell' | 'route' | 'panel' | 'message' | 'artifact' | 'node' | 'lazy';

const NAMES: Record<BoundaryScope, string> = {
  shell: 'NVX Ancile',
  route: 'This screen',
  panel: 'This panel',
  message: 'This message',
  artifact: 'This artifact',
  node: 'This node',
  lazy: 'This part',
};

/** A dynamic import that never arrived: offline, or a deploy replaced the file. */
export const isChunkError = (e: unknown) =>
  /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i.test(
    `${(e as Error | undefined)?.name ?? ''} ${(e as Error | undefined)?.message ?? ''}`,
  );

interface Props {
  scope: BoundaryScope;
  /** What this is called in the fallback, e.g. "The activity panel". */
  label?: string;
  children: ReactNode;
  /** Runs before the children mount again (lazyHost re-requests its chunk here). */
  onRetry?: () => void;
  /** A compact card, for hosts that are usually invisible. */
  quiet?: boolean;
}
interface State {
  error: Error | null;
  failures: number;
  /** The full card, once its chunk has arrived. */
  Full: ComponentType<FallbackProps> | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, failures: 0, Full: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState((s) => ({ failures: s.failures + 1 }));
    console.error(
      'boundary',
      this.props.scope,
      COCKPIT_VERSION,
      error.message,
      info.componentStack?.slice(0, 400),
    );
    if (!this.state.Full)
      import('./ErrorFallback').then((m) => this.setState({ Full: m.ErrorFallback })).catch(() => {});
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render() {
    const { error, failures, Full } = this.state;
    const { scope, label, quiet, children } = this.props;
    if (!error) return children;
    // Failed again after a reload: the boundary above takes it, so a broken child can never loop.
    if (failures > 1 && scope !== 'shell') throw error;

    const chunk = isChunkError(error);
    const name = label ?? NAMES[scope];
    const title = chunk ? `${name} did not load` : `${name} stopped working`;
    const hint = chunk
      ? 'The file could not be fetched. Check your connection, then try again.'
      : scope === 'shell'
        ? 'Reload to carry on. If it keeps happening, start in safe mode.'
        : 'The rest of NVX Ancile still works. Custom CSS or a plugin can cause this: try safe mode.';
    if (Full)
      return (
        <Full
          scope={scope}
          label={label}
          quiet={quiet}
          error={error}
          title={title}
          hint={hint}
          chunk={chunk}
          onRetry={this.retry}
        />
      );
    // Stands in until the full card arrives (or if it cannot): same shape, the one button that matters.
    return (
      <div className="error-state" role="alert" data-compact={quiet || undefined} data-boundary={scope}>
        <span className="error-state__icon" aria-hidden="true" />
        <div className="error-state__text">
          <p className="error-state__title">{title}</p>
          <p className="error-state__hint">{hint}</p>
          <div className="error-state__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={scope === 'shell' ? () => location.reload() : this.retry}
            >
              {scope === 'shell' ? 'Reload' : chunk ? 'Try again' : 'Reload this panel'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
