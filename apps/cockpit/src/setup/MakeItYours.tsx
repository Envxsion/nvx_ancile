/**
 * ------------------------------------------------------------------
 *  Title    |  First run: make it yours, and the first notebook
 *  Ref      |  ROADMAP SU1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Two short, skippable steps of first run: how it should
 *           |  look (theme, accent, density), and a first notebook
 *           |  with files dragged in.
 *  How      |  The look is the real preferences: choosing changes the
 *           |  window you are looking at, which is the live preview,
 *           |  and it is the same setting Settings → Appearance
 *           |  holds. The notebook step makes the notebook, then hands
 *           |  its files to the upload queue; nothing is made until
 *           |  you press the button.
 *  Note     |  Both can be skipped with their defaults, and neither
 *           |  is needed for a first answer.
 * ------------------------------------------------------------------
 */

import { ACCENTS } from '@nvx/contracts/prefs';
import { useNavigate } from '@tanstack/react-router';
import { type CSSProperties, useRef, useState } from 'react';
import { createNotebook } from '../lib/notebooks';
import { useUploads } from '../sources/uploads';
import { usePrefs } from '../state/prefs';
import { Segmented } from '../ui/controls';
import '../styles/setup.css';
import { Icon } from '../ui/Icon';

const ACCENT_LABEL: Record<(typeof ACCENTS)[number], string> = {
  ultraviolet: 'Ultraviolet',
  iris: 'Iris',
  orchid: 'Orchid',
  rose: 'Rose',
  ember: 'Ember',
  jade: 'Jade',
  graphite: 'Graphite',
};
const ACCENT_SWATCH: Record<(typeof ACCENTS)[number], string> = {
  ultraviolet: '#9d86ff',
  iris: '#8ea4ff',
  orchid: '#d28bff',
  rose: '#ff7fa6',
  ember: '#ff8f66',
  jade: '#4fd69e',
  graphite: '#d7dbe2',
};

export function MakeItYours() {
  const a = usePrefs((s) => s.prefs.appearance);
  const density = usePrefs((s) => s.prefs.layout.density);
  const set = usePrefs((s) => s.set);
  return (
    <div className="lookstep">
      <div className="lookstep__row">
        <span className="lookstep__label" id="look-theme">
          Theme
        </span>
        <Segmented
          label="Theme"
          value={a.theme}
          onChange={(theme) => set('appearance', { theme })}
          options={[
            { value: 'system', label: 'Match my computer' },
            { value: 'dark', label: 'Dark', icon: 'moon' },
            { value: 'light', label: 'Light', icon: 'sun' },
          ]}
        />
      </div>
      <div className="lookstep__row">
        <span className="lookstep__label">Accent</span>
        <div className="swatches" role="radiogroup" aria-label="Accent">
          {ACCENTS.map((x) => (
            <button
              key={x}
              type="button"
              role="radio"
              aria-checked={a.accent === x}
              className="swatch"
              style={{ '--swatch': ACCENT_SWATCH[x] } as CSSProperties}
              onClick={() => set('appearance', { accent: x })}
            >
              <span className="swatch__chip" aria-hidden="true" />
              <span className="swatch__label">{ACCENT_LABEL[x]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="lookstep__row">
        <span className="lookstep__label">Density</span>
        <Segmented
          label="Density"
          value={density}
          onChange={(d) => set('layout', { density: d })}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'spacious', label: 'Spacious' },
          ]}
        />
      </div>
      <p className="mute">The window changes as you choose. More is in Settings, any time.</p>
    </div>
  );
}

export function FirstNotebook() {
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; files: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = useUploads((s) => s.add);
  const navigate = useNavigate();

  const make = async () => {
    setBusy(true);
    const nb = await createNotebook({ title: title.trim() || 'My first notebook' });
    setBusy(false);
    if (!nb) return;
    if (files.length) add(nb.id, files);
    setMade({ id: nb.id, files: files.length });
    setFiles([]);
  };

  if (made)
    return (
      <p role="status" className="lookstep__done">
        <Icon name="check" size={13} /> Your notebook is made
        {made.files
          ? `. Its ${made.files} ${made.files === 1 ? 'file is' : 'files are'} being read in the background`
          : ''}
        .{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() => void navigate({ to: '/n/$notebookId', params: { notebookId: made.id } })}
        >
          Open it
        </button>
      </p>
    );

  return (
    <div className="lookstep">
      <label className="field">
        <span>What is it about?</span>
        <input
          className="input"
          value={title}
          maxLength={120}
          placeholder="My first notebook"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside opens the file picker */}
      <div
        className="chatimp__drop"
        data-over={over || undefined}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]);
        }}
      >
        <button type="button" className="btn" onClick={() => input.current?.click()}>
          <Icon name="upload" size={14} />
          Choose files
        </button>
        <span className="mute">
          or drag them in. PDFs, documents, notes and web pages saved as files work.
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {files.length ? (
        <ul className="lookstep__files" aria-label="Files to add">
          {files.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same file can be chosen twice
            <li key={`${f.name}-${i}`}>{f.name}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={() => void make()}
        >
          {busy ? 'Making it' : files.length ? 'Make the notebook and add the files' : 'Make the notebook'}
        </button>
      </div>
    </div>
  );
}
