/**
 * ------------------------------------------------------------------
 *  Title    |  Source details
 *  Ref      |  ROADMAP S6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Edit what NVX Ancile knows about a source beyond its
 *           |  text: tags, author, date published and language.
 *  How      |  A dialog opened from the source's menu, loaded on
 *           |  demand. Tags are chips you add with Enter or a comma
 *           |  and take off with their button. The language starts at
 *           |  what was detected; choosing one sets it by hand and it
 *           |  stays, "Detected" hands the choice back. Only what
 *           |  changed is sent.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useId, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { type SourceDetailsPatch, saveSourceDetails } from '../lib/notebooks';
import type { SourceView } from '../lib/types';
import { Icon } from '../ui/Icon';
import { LANGUAGES, MAX_TAGS, parseTags } from './tags';

const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

export function SourceDetails({ s, onClose }: { s: SourceView; onClose: () => void }) {
  useLayer(true);
  const id = useId();
  const [tags, setTags] = useState<string[]>(s.tags);
  const [draft, setDraft] = useState('');
  const [author, setAuthor] = useState(s.author ?? '');
  const [date, setDate] = useState(s.publishedOn ?? '');
  const [language, setLanguage] = useState(s.language ?? '');
  const [saving, setSaving] = useState(false);

  const addDraft = () => {
    const more = parseTags(draft);
    if (more.length) setTags((t) => parseTags([...t, ...more].join(',')));
    setDraft('');
  };
  const dateOk = date === '' || /^\d{4}-\d{2}-\d{2}$/.test(date);

  const save = async () => {
    const finalTags = parseTags([...tags, ...parseTags(draft)].join(','));
    const patch: SourceDetailsPatch = {};
    if (finalTags.join('\n') !== s.tags.join('\n')) patch.tags = finalTags;
    if (author.trim() !== (s.author ?? '')) patch.author = author.trim() || null;
    if (date !== (s.publishedOn ?? '')) patch.published_on = date || null;
    if (language !== (s.language ?? '')) patch.language = language || null;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const ok = await saveSourceDetails(s.id, patch);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick" aria-describedby={`${id}-lede`}>
          <Dialog.Title className="dialog__title" dir="auto">
            Details for {s.title}
          </Dialog.Title>
          <p id={`${id}-lede`} className="dialog__lede">
            Tags, author, date and language help you find and filter sources. They are never sent to a model
            unless a question cites this source.
          </p>

          <div className="field">
            <label htmlFor={`${id}-tag`}>Tags</label>
            {tags.length ? (
              <ul className="source-tags" aria-label="Tags on this source">
                {tags.map((t) => (
                  <li key={t} className="tag">
                    {t}
                    <button
                      type="button"
                      className="icon-btn icon-btn--xs"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => setTags((all) => all.filter((x) => x !== t))}
                    >
                      <Icon name="close" size={9} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <input
              id={`${id}-tag`}
              className="input input--sm"
              value={draft}
              maxLength={60}
              disabled={tags.length >= MAX_TAGS}
              placeholder={tags.length >= MAX_TAGS ? `Up to ${MAX_TAGS} tags` : 'Add a tag, then press Enter'}
              onChange={(e) => {
                if (e.target.value.includes(',')) {
                  setDraft(e.target.value);
                  setTimeout(addDraft, 0);
                } else setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraft();
                }
                if (e.key === 'Backspace' && !draft && tags.length) setTags((t) => t.slice(0, -1));
              }}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-author`}>Author</label>
            <input
              id={`${id}-author`}
              className="input input--sm"
              value={author}
              maxLength={200}
              dir="auto"
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-date`}>Date published</label>
            <input
              id={`${id}-date`}
              className="input input--sm"
              type="date"
              value={date}
              aria-invalid={!dateOk || undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-lang`}>Language</label>
            <select
              id={`${id}-lang`}
              className="input input--sm"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="">Detected from the text</option>
              {language && !LANGUAGES.some((l) => l.code === language) ? (
                <option value={language}>{languageName(language)}</option>
              ) : null}
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving || !dateOk}
              onClick={() => void save()}
            >
              Save details
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
