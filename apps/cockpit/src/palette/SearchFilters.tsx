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
 *           |  Pro adds tool outputs, notes, fact-check claims and
 *           |  saved searches (TODO(phase-0.1.1), Pro seam).
 * ------------------------------------------------------------------
 */

import { useModels, useNotebooks } from '../lib/data';
import type { SearchFilter } from '../lib/searchFilter';

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
  );
}
