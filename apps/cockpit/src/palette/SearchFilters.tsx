/**
 * ------------------------------------------------------------------
 *  Title    |  Filters for searching messages
 *  Ref      |  roadmap TS1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Narrow a message search in Ctrl+K by who wrote the
 *           |  words, notebook, model and date.
 *  How      |  A row of plain controls under the search box. Each is
 *           |  a labelled native control, so the keyboard and screen
 *           |  readers need nothing extra. Empty means no filter.
 *           |  Below them, Pro's own part (ProUi.parts.SearchPro,
 *           |  gated by the insights feature) also searches tool
 *           |  outputs, notes and fact-check claims, each hit labelled
 *           |  with its kind, and keeps searches by name; without Pro
 *           |  a gilt line says so. The exported filter type is
 *           |  lib/searchFilter.ts's and is unchanged.
 * ------------------------------------------------------------------
 */

import { useNavigate } from '@tanstack/react-router';
import { useModels, useNotebooks } from '../lib/data';
import { setPaletteText, usePaletteText } from '../lib/paletteInput';
import type { SearchFilter } from '../lib/searchFilter';
import { ProNudge } from '../pro/ProNudge';
import { type SearchProTarget, useProFeature } from '../pro/slot';
import { useUi } from '../state/ui';
import '../styles/tsfind.css';

/** Pro's search of tool outputs, notes and claims, and saved searches; a gilt line without it. */
function ProSearch({ value, onChange }: { value: SearchFilter; onChange: (next: SearchFilter) => void }) {
  const { ui, unlocked, build, loading, noSeat } = useProFeature('insights');
  const query = usePaletteText();
  const navigate = useNavigate();
  if (loading) return <p className="ts-load mute">Checking Pro</p>;
  const Part = ui?.parts?.SearchPro;
  if (!Part || !unlocked)
    return (
      <ProNudge
        what="Search tool outputs, notes and fact-check claims, and keep searches you use often."
        build={build}
        noSeat={noSeat}
      />
    );
  const open = (t: SearchProTarget) => {
    useUi.getState().closePalette();
    if (t.threadId)
      void navigate({
        to: '/t/$threadId',
        params: { threadId: t.threadId },
        ...(t.messageId && { hash: t.messageId }),
      });
    else if (t.notebookId) void navigate({ to: '/n/$notebookId', params: { notebookId: t.notebookId } });
  };
  return (
    <Part
      query={query}
      filter={value}
      apply={(q, f) => {
        onChange(f);
        setPaletteText(q);
      }}
      open={open}
    />
  );
}

export function SearchFilters({
  value,
  onChange,
}: {
  value: SearchFilter;
  onChange: (next: SearchFilter) => void;
}) {
  const notebooks = useNotebooks().data ?? [];
  const models = useModels({ all: true }).data ?? [];
  const set = (patch: Partial<SearchFilter>) => {
    const next = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof SearchFilter)[]) if (!next[k]) delete next[k];
    onChange(next);
  };
  return (
    <>
      <fieldset className="palette__filters">
        <legend className="sr-only">Narrow the search</legend>
        <label>
          <span className="mute">Words by</span>
          <select
            value={value.who ?? ''}
            onChange={(e) => set({ who: (e.target.value || undefined) as never })}
          >
            <option value="">Anyone</option>
            <option value="mine">Me</option>
            <option value="answers">Answers</option>
          </select>
        </label>
        <label>
          <span className="mute">Notebook</span>
          <select value={value.notebook ?? ''} onChange={(e) => set({ notebook: e.target.value })}>
            <option value="">Any</option>
            {notebooks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="mute">Model</span>
          <select value={value.model ?? ''} onChange={(e) => set({ model: e.target.value })}>
            <option value="">Any</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="mute">From</span>
          <input type="date" value={value.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label>
          <span className="mute">To</span>
          <input type="date" value={value.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
        </label>
      </fieldset>
      <ProSearch value={value} onChange={onChange} />
    </>
  );
}
