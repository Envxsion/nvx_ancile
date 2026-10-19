/**
 * ------------------------------------------------------------------
 *  Title    |  Tool step, loaded on demand
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Keep the step cards (ToolStepCards.tsx: a diff view,
 *           |  a terminal, search hits, a Python run) out of the
 *           |  first download.
 *  How      |  Until the cards arrive, a closed row of the same height
 *           |  with the step's own words stands in
 *           |  (ToolStepPlaceholder). Once the module is in, every
 *           |  step draws at once. A chunk that cannot be fetched
 *           |  throws to the message's boundary, which offers
 *           |  "Try again" (never a card that stays a placeholder).
 *  Note     |  Tests load the cards in test/setup.ts so steps draw
 *           |  synchronously there.
 * ------------------------------------------------------------------
 */

import { type ComponentType, memo, useEffect, useState } from 'react';
import type { ToolStepProps } from './ToolStepCards';
import { ToolStepPlaceholder } from './ToolSteps';

let cards: ComponentType<ToolStepProps> | null = null;
let loading: Promise<void> | null = null;

/** Fetch the cards once; a failure is forgotten so the next try asks again. */
export function loadToolStepCards(): Promise<void> {
  loading ??= import('./ToolStepCards').then(
    (m) => {
      cards = m.ToolStep;
    },
    (e) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

export const ToolStep = memo(function ToolStep(props: ToolStepProps) {
  const [Cards, setCards] = useState<ComponentType<ToolStepProps> | null>(cards);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    if (cards) {
      setCards(() => cards);
      return;
    }
    let live = true;
    loadToolStepCards().then(
      () => live && setCards(() => cards),
      (e) => live && setFailure(e ?? new Error('The step cards did not load')),
    );
    return () => {
      live = false;
    };
  }, []);
  if (failure) throw failure;
  const Ready = cards ?? Cards;
  return Ready ? <Ready {...props} /> : <ToolStepPlaceholder {...props} />;
});
