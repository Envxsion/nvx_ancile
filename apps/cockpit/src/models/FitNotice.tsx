/**
 * ------------------------------------------------------------------
 *  Title    |  "Needs summarising to fit (about 340k → 120k)"
 *  Ref      |  ROADMAP.md HO1 · docs/prompt-caching.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Before a thread moves to a model whose window will not
 *           |  hold it, say so once and let the person decide, instead
 *           |  of it being summarised behind their back at the next
 *           |  message. Nothing is shown when the thread fits.
 *  How      |  Picking a model asks GET /threads/:id/context-budget
 *           |  ?model= (chooseModel, lib/models.ts). If the answer says
 *           |  `fit.needs_summary`, the switch waits and this line shows
 *           |  under the composer notices with two words of choice:
 *           |  Switch and summarise (summarise for that window, then
 *           |  switch) or Pick another (stay where you are). A failed
 *           |  request means "no information": the switch goes ahead.
 *  Note     |  The full thread always stays; only what the model reads
 *           |  is shorter. Numbers are estimates.
 * ------------------------------------------------------------------
 */

import { compactNow } from '../lib/branching';
import { chooseModel } from '../lib/models';
import { fitLine, useFitAsk } from './fit';
import '../styles/cache.css';

export function FitNotice({ threadId }: { threadId: string }) {
  const ask = useFitAsk((s) => s.ask);
  if (!ask || ask.threadId !== threadId) return null;
  const clear = () => useFitAsk.setState({ ask: null });
  return (
    <div className="switch-cost" role="status" data-tour="fit-line">
      <span className="switch-cost__text">{fitLine(ask)}</span>
      {ask.after === null ? null : (
        <button
          type="button"
          className="switch-cost__act"
          onClick={async () => {
            clear();
            if (ask.ready || (await compactNow(threadId, null, ask.model.id)))
              await chooseModel(ask.model, threadId, true);
          }}
        >
          Switch and summarise
        </button>
      )}
      <button type="button" className="switch-cost__act" onClick={clear}>
        Pick another
      </button>
    </div>
  );
}
