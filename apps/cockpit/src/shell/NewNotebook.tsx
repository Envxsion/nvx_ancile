/**
 * ------------------------------------------------------------------
 *  Title    |  New notebook
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Name it and pick its colour, right where it will live
 *           |  in the rail. Enter makes it and opens it; Esc lets go.
 * ------------------------------------------------------------------
 */

import { useNavigate } from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { helpDone } from '../help/store';
import { tourEvent } from '../help/tours';
import { hueVar } from '../lib/format';
import { createNotebook } from '../lib/notebooks';
import type { Hue } from '../lib/types';

export const NOTEBOOK_HUES: Hue[] = ['azure', 'jade', 'amber', 'coral', 'magenta', 'cyan', 'chalk'];

export function NewNotebook({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [hue, setHue] = useState<Hue>('azure');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => ref.current?.focus(), []);

  const create = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    const nb = await createNotebook({ title: t, color: hue });
    setBusy(false);
    if (!nb) return;
    helpDone('notebook');
    tourEvent('notebook-created');
    onDone();
    void navigate({ to: '/n/$notebookId', params: { notebookId: nb.id } });
  };

  return (
    <form
      className="new-nb"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      style={{ '--hue': hueVar(hue) } as CSSProperties}
    >
      <span className="rail__swatch" aria-hidden="true" />
      <input
        ref={ref}
        className="new-nb__input"
        value={title}
        placeholder="Name the notebook"
        aria-label="Notebook name"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
        onBlur={(e) => {
          if (!title.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node | null)) onDone();
        }}
        maxLength={200}
      />
      <div className="new-nb__hues" role="radiogroup" aria-label="Colour">
        {NOTEBOOK_HUES.map((h) => (
          <button
            key={h}
            type="button"
            role="radio"
            aria-checked={h === hue}
            aria-label={h}
            className="new-nb__hue"
            style={{ '--hue': hueVar(h) } as CSSProperties}
            onClick={() => {
              setHue(h);
              ref.current?.focus();
            }}
          />
        ))}
      </div>
    </form>
  );
}
