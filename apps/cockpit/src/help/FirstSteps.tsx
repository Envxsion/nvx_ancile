/**
 * ------------------------------------------------------------------
 *  Title    |  First steps on Home
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The next three things worth learning, where a new
 *           |  person actually looks: under the composer on Home.
 *           |  Each card does the thing (or walks you through it),
 *           |  rather than linking to a page about it.
 *  How      |  Reads useFirstSteps. A step's tour starts where its
 *           |  targets are: the latest notebook thread for citations
 *           |  and branches, a notebook for sources and flows. Hidden
 *           |  once every step is done or the list is dismissed; Home
 *           |  then shows its usual starters.
 * ------------------------------------------------------------------
 */

import { useNavigate } from '@tanstack/react-router';
import { useNotebooks, useThreads } from '../lib/data';
import { useUi } from '../state/ui';
import '../styles/learn.css';
import { Icon } from '../ui/Icon';
import { type FirstStep, useFirstSteps } from './steps';
import { useHelp } from './store';
import { TOURS } from './tours';

/** Wait (up to 3 s) for a tour target to render after a route change. */
function whenShown(target: string): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        resolve();
      } else if (Date.now() - started > 3_000) resolve();
      else setTimeout(look, 100);
    };
    look();
  });
}

/** Do a step: open the palette scope, or go where its tour can point, then start it. */
export function useRunStep() {
  const navigate = useNavigate();
  const threads = useThreads().data ?? [];
  const notebooks = (useNotebooks().data ?? []).filter((n) => !n.archived);
  const openPalette = useUi((s) => s.openPalette);
  const { startTour, stepTour } = useHelp.getState();

  return async (step: FirstStep) => {
    if (step.palette) {
      openPalette(step.palette);
      return;
    }
    if (!step.tour) {
      useUi.getState().setHelp(true, step.article);
      return;
    }
    const notebook = notebooks.find((n) => n.sources > 0) ?? notebooks[0];
    // A thread in a notebook with sources is the likeliest to have citations.
    const withSources = new Set(notebooks.filter((n) => n.sources > 0).map((n) => n.id));
    const groundedThread = threads.find((t) => t.notebookId && withSources.has(t.notebookId)) ?? threads[0];
    if ((step.id === 'cite' || step.id === 'branch') && groundedThread) {
      await navigate({ to: '/t/$threadId', params: { threadId: groundedThread.id } });
    } else if ((step.id === 'source' || step.id === 'flow') && notebook) {
      await navigate({ to: '/n/$notebookId', params: { notebookId: notebook.id } });
    } else if (step.id === 'notebook' && !useUi.getState().railOpen) {
      useUi.getState().toggleRail();
    }
    // With a notebook already there, the notebook tour starts at its sources.
    const first = step.id === 'source' && notebook ? 1 : 0;
    const target = TOURS[step.tour]?.steps[first]?.target;
    if (target) await whenShown(target);
    startTour(step.tour);
    if (first) stepTour(first);
  };
}

export function FirstSteps() {
  const steps = useFirstSteps();
  const run = useRunStep();
  const dismiss = useHelp((s) => s.dismissChecklist);
  const setHelp = useUi((s) => s.setHelp);
  if (steps.complete || steps.dismissed) return null;
  const next = steps.next.slice(0, 3);

  return (
    <section className="first-steps" aria-labelledby="first-steps-title">
      <header className="first-steps__head">
        <h2 id="first-steps-title" className="home__h">
          Learn NVX Ancile in a few minutes
        </h2>
        <span className="first-steps__count mute">
          {steps.done} of {steps.total} done
        </span>
        <button type="button" className="link-btn link-btn--quiet" onClick={dismiss}>
          Hide
        </button>
      </header>
      <div className="first-steps__grid">
        {next.map((s) => (
          <article key={s.id} className="first-step">
            <h3 className="first-step__title">{s.label}</h3>
            <p className="first-step__why">{s.why}</p>
            <div className="first-step__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void run(s)}>
                {s.action}
              </button>
              <button
                type="button"
                className="link-btn link-btn--quiet"
                onClick={() => setHelp(true, s.article)}
              >
                <Icon name="book" size={12} /> Read about it
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
