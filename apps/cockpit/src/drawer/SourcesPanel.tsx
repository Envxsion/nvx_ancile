/**
 * ------------------------------------------------------------------
 *  Title    |  Sources panel
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The sources beside the conversation: what this
 *           |  notebook knows, what is still being read, and the
 *           |  viewer when a citation is opened.
 *  How      |  The notebook comes from the route (a notebook page, or
 *           |  a thread inside one). Without a notebook the panel
 *           |  offers to put the thread into one. A notebook whose
 *           |  sources mix languages under an English-only embedder
 *           |  gets a one-line hint naming the multilingual option.
 * ------------------------------------------------------------------
 */

import type { NotebookLanguages } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Hint } from '../help/Hint';
import { api } from '../lib/api';
import { useNotebooks, useSources, useThread } from '../lib/data';
import { setCheckOnWeb, setCritical, setGrounded, setShareChecks, useVerdictCache } from '../lib/factcheck';
import { tagSources } from '../lib/notebooks';
import { moveThread } from '../lib/threads';
import { AddSources } from '../sources/AddSources';
import { SourceCard } from '../sources/SourceCard';
import { SourceViewer } from '../sources/SourceViewer';
import { hasTag, parseTags, tagCounts } from '../sources/tags';
import { useUploads } from '../sources/uploads';
import { useUi } from '../state/ui';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { LoadFailed, StaleNotice } from '../ui/LoadFailed';
import { DropMenu } from '../ui/Menu';
import { EmptyState, Skeleton } from '../ui/primitives';

/** The notebook the screen belongs to: the notebook page, or the thread's notebook. */
export function useContextNotebook(): string | null {
  const params = useParams({ strict: false }) as { notebookId?: string; threadId?: string };
  const thread = useThread(params.threadId);
  return params.notebookId ?? thread.data?.notebookId ?? null;
}

export function UploadQueue({ notebookId }: { notebookId: string }) {
  // Select the stable list, filter outside: a fresh array from a selector re-renders for ever.
  const all = useUploads((s) => s.items);
  const items = useMemo(() => all.filter((u) => u.notebookId === notebookId), [all, notebookId]);
  const cancel = useUploads((s) => s.cancel);
  if (!items.length) return null;
  return (
    <ul className="uploads" aria-label="Uploads">
      {items.map((u) => (
        <li key={u.id} className="upload" data-state={u.state}>
          <Icon name={u.state === 'failed' ? 'warn' : u.state === 'done' ? 'check' : 'upload'} size={13} />
          <span className="upload__name">{u.name}</span>
          <span className="upload__pct mute" data-num>
            {u.state === 'waiting'
              ? 'Waiting'
              : u.state === 'failed'
                ? 'Failed'
                : u.state === 'done'
                  ? 'Sent'
                  : `${Math.round(u.progress * 100)}%`}
          </span>
          {u.state === 'waiting' || u.state === 'sending' || u.state === 'failed' ? (
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label={`Cancel ${u.name}`}
              onClick={() => cancel(u.id)}
            >
              <Icon name="close" size={10} />
            </button>
          ) : null}
          <span className="upload__bar" style={{ transform: `scaleX(${u.progress})` }} aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}

function NoNotebook() {
  const params = useParams({ strict: false }) as { threadId?: string };
  const notebooks = useNotebooks();
  const list = notebooks.data ?? [];
  return (
    <EmptyState
      icon="notebook"
      title="This thread is not in a notebook"
      body="Put it in one and its questions are answered from that notebook's sources, with citations."
      secondary={
        params.threadId && list.length ? (
          <DropMenu
            align="center"
            items={list.map((n) => ({
              label: n.title,
              onSelect: () => void moveThread(params.threadId ?? '', n.id, n.title),
            }))}
            trigger={
              <button type="button" className="btn btn--primary">
                <Icon name="notebook" size={14} />
                Move into a notebook
              </button>
            }
          />
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.dispatchEvent(new CustomEvent('ancile:new-notebook'))}
          >
            <Icon name="plus" size={14} />
            Start a notebook
          </button>
        )
      }
    />
  );
}

/** Grounded mode, beside the sources it checks against (DESIGN.md §10.7). */
function GroundedRow({ notebookId }: { notebookId: string }) {
  const notebooks = useNotebooks();
  const on = notebooks.data?.find((n) => n.id === notebookId)?.grounded === true;
  const [busy, setBusy] = useState(false);
  return (
    <div className="grounded-row" data-on={on || undefined}>
      <Icon name="factcheck" size={14} />
      <div className="grounded-row__text">
        <span className="grounded-row__title">
          Fact-check every answer
          <Hint id="grounded-mode" title="Grounded mode" article="fact-checking">
            Grounded mode checks each claim against these sources.
          </Hint>
        </span>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        label="Fact-check every answer in this notebook"
        onChange={async (next) => {
          setBusy(true);
          await setGrounded(notebookId, next);
          setBusy(false);
        }}
      />
    </div>
  );
}

/** Whether a fact-check here may look claims up on the web (roadmap FC4). Off unless you turn it on. */
function WebRow({ notebookId }: { notebookId: string }) {
  const notebooks = useNotebooks();
  const on = notebooks.data?.find((n) => n.id === notebookId)?.check_on_web === true;
  const [busy, setBusy] = useState(false);
  return (
    <div className="grounded-row" data-on={on || undefined}>
      <Icon name="globe" size={14} />
      <div className="grounded-row__text">
        <span className="grounded-row__title">
          Check on the web
          <Hint id="check-on-web" title="Check on the web">
            Claims your sources miss are looked up on the web and marked Web. Never in a private notebook.
          </Hint>
        </span>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        label="Let fact-checks in this notebook use the web"
        onChange={async (next) => {
          setBusy(true);
          await setCheckOnWeb(notebookId, next);
          setBusy(false);
        }}
      />
    </div>
  );
}

/** Mission-critical checks: two standard or frontier models per claim (TR3). Off unless you turn it on. */
function CriticalRow({ notebookId }: { notebookId: string }) {
  const notebooks = useNotebooks();
  const on = notebooks.data?.find((n) => n.id === notebookId)?.critical === true;
  const [busy, setBusy] = useState(false);
  return (
    <div className="grounded-row" data-on={on || undefined}>
      <Icon name="seal" size={14} />
      <div className="grounded-row__text">
        <span className="grounded-row__title">
          Mission-critical checks
          <Hint id="critical-checks" title="Mission-critical checks">
            Every claim is checked by two standard or frontier models, never a small one. If two are not
            ready, you choose which to use. Slower and dearer.
          </Hint>
        </span>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        label="Check every claim in this notebook with two standard or frontier models"
        onChange={async (next) => {
          setBusy(true);
          await setCritical(notebookId, next);
          setBusy(false);
        }}
      />
    </div>
  );
}

/** Share this notebook's checked claims with the others, and take theirs (SI1). */
function ShareChecksRow({ notebookId }: { notebookId: string }) {
  const cache = useVerdictCache(notebookId);
  const on = cache.data?.scope === 'global';
  const [busy, setBusy] = useState(false);
  if (!cache.data) return null;
  return (
    <div className="grounded-row" data-on={on || undefined}>
      <Icon name="link" size={14} />
      <div className="grounded-row__text">
        <span className="grounded-row__title">
          Share checks with other notebooks
          <Hint id="share-checks" title="Share checks">
            {`${cache.data.entries === 1 ? '1 checked claim is' : `${cache.data.entries} checked claims are`} kept here. Shared, a claim checked here answers the same claim elsewhere, and the other way round. Checks against your own sources never leave this notebook.${cache.data.share_note ? ` ${cache.data.share_note}` : ''}`}
          </Hint>
        </span>
      </div>
      <Switch
        checked={on}
        disabled={busy || (!on && !cache.data.can_share)}
        label="Share this notebook's checked claims with your other notebooks"
        onChange={async (next) => {
          setBusy(true);
          await setShareChecks(notebookId, next);
          setBusy(false);
        }}
      />
    </div>
  );
}

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'language' });
  } catch {
    return null;
  }
})();
const languageName = (code: string) => languageNames?.of(code) ?? code;

/** "English and French", "English, French and German". */
export function listLanguages(codes: string[]): string {
  const names = codes.map(languageName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/**
 * Sources in several languages, searched with an English-only embedder:
 * say so in one line and name the multilingual model to switch to.
 * TODO(phase-3): switch in one click. Background re-embedding is in place (POST
 * /knowledge/embeddings/check); what is missing is a runtime setting for the
 * embedding model, which today is the KNOWLEDGE_EMBED_MODEL env var.
 */
function LanguageHint({ notebookId }: { notebookId: string }) {
  const langs = useQuery({
    queryKey: ['notebook-languages', notebookId],
    staleTime: 60_000,
    retry: false,
    queryFn: () => api.get<NotebookLanguages>(`/notebooks/${notebookId}/languages`),
  });
  const [copied, setCopied] = useState(false);
  const d = langs.data;
  if (!d?.mixed || d.embedder.multilingual || !d.multilingual_option) return null;
  const setting = `KNOWLEDGE_EMBED_MODEL=${d.multilingual_option}`;
  return (
    <p className="lang-hint" role="note">
      <Icon name="globe" size={13} />
      <span>
        These sources are in {listLanguages(d.languages.map((l) => l.code))}, and search reads English best. A
        multilingual embedder reads them all.
      </span>
      <button
        type="button"
        className="link-btn"
        title={`${setting}, then restart NVX Ancile`}
        onClick={() => {
          void navigator.clipboard?.writeText(setting).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy the setting'}
      </button>
    </p>
  );
}

type Filter = 'all' | 'working' | 'problems';

export function SourcesPanel() {
  const notebookId = useContextNotebook();
  const sources = useSources(notebookId);
  const viewer = useUi((s) => s.viewer);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // Tags (ROADMAP S6): filter by one, or select several sources to tag them together.
  const [tag, setTag] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [tagText, setTagText] = useState('');

  const items = sources.data ?? [];
  const tags = useMemo(() => tagCounts(items), [items]);
  const shown = useMemo(
    () =>
      items.filter((s) => {
        if (
          q &&
          !s.title.toLowerCase().includes(q.toLowerCase()) &&
          !s.tags.some((t) => t.includes(q.toLowerCase()))
        )
          return false;
        if (tag && !hasTag(s, tag)) return false;
        if (filter === 'working') return !['ready', 'failed', 'stale'].includes(s.status);
        if (filter === 'problems') return s.status === 'failed' || s.status === 'stale' || !!s.duplicateOf;
        return true;
      }),
    [items, q, filter, tag],
  );

  if (viewer) return <SourceViewer {...viewer} />;
  if (!notebookId) return <NoNotebook />;
  if (sources.isPending) return <Skeleton lines={6} label="Loading sources" />;
  // A failed read is not "No sources yet": say what failed, with Try again.
  if (sources.isError && !sources.data)
    return <LoadFailed error={sources.error} what="Sources" onRetry={() => sources.refetch()} />;

  const working = items.filter((s) => !['ready', 'failed', 'stale'].includes(s.status)).length;
  const problems = items.filter(
    (s) => s.status === 'failed' || s.status === 'stale' || !!s.duplicateOf,
  ).length;

  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="mute">
          <span data-num>{items.length}</span> {items.length === 1 ? 'source' : 'sources'}
          {working ? (
            <>
              {' · '}
              <span data-num>{working}</span> being read
            </>
          ) : null}
        </span>
        <span className="panel__bar-acts">
          {items.length > 1 ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={selecting}
              onClick={() => {
                setSelecting((on) => !on);
                setPicked(new Set());
              }}
            >
              {selecting ? 'Done' : 'Select'}
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} />
            Add
          </button>
        </span>
      </div>
      {sources.isError ? (
        <StaleNotice error={sources.error} what="Sources" onRetry={() => sources.refetch()} />
      ) : null}
      <UploadQueue notebookId={notebookId} />
      {items.length ? <GroundedRow notebookId={notebookId} /> : null}
      {items.length ? <WebRow notebookId={notebookId} /> : null}
      {items.length ? <CriticalRow notebookId={notebookId} /> : null}
      {items.length ? <ShareChecksRow notebookId={notebookId} /> : null}
      {items.length > 1 ? <LanguageHint notebookId={notebookId} /> : null}
      {items.length === 0 ? (
        <EmptyState
          icon="upload"
          title="No sources yet"
          body="Drop files here, paste a link or text, or add a past thread. Answers will cite them."
          action={{ label: 'Add sources', onClick: () => setAdding(true) }}
        />
      ) : (
        <>
          {items.length > 5 ? (
            <div className="panel__filters">
              <label className="panel__search">
                <Icon name="search" size={12} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter sources"
                  aria-label="Filter sources"
                />
              </label>
              {(['all', 'working', 'problems'] as const).map((f) =>
                f === 'all' || (f === 'working' ? working : problems) ? (
                  <button
                    key={f}
                    type="button"
                    className="chip"
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {f === 'all'
                      ? 'All'
                      : f === 'working'
                        ? `Being read ${working}`
                        : `Need attention ${problems}`}
                  </button>
                ) : null,
              )}
            </div>
          ) : null}
          {tags.length > 0 ? (
            <div className="panel__tags" role="group" aria-label="Filter sources by tag">
              {tags.slice(0, 12).map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  className="tag tag--btn"
                  aria-pressed={tag?.toLowerCase() === t.tag.toLowerCase()}
                  onClick={() => setTag((cur) => (cur?.toLowerCase() === t.tag.toLowerCase() ? null : t.tag))}
                >
                  {t.tag}
                  <span data-num>{t.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {selecting ? (
            <div className="tagbar" role="group" aria-label="Tag the selected sources">
              <span className="tagbar__count" data-num>
                {picked.size} selected
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setPicked(new Set(shown.map((x) => x.id)))}
              >
                Select all shown
              </button>
              <input
                className="input input--sm"
                value={tagText}
                placeholder="Tags, separated by commas"
                aria-label="Tags to add or remove"
                onChange={(e) => setTagText(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={picked.size === 0 || parseTags(tagText).length === 0}
                onClick={() =>
                  void tagSources(
                    items.filter((x) => picked.has(x.id)),
                    parseTags(tagText),
                    [],
                  ).then(() => setTagText(''))
                }
              >
                Add tags
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={picked.size === 0 || parseTags(tagText).length === 0}
                onClick={() =>
                  void tagSources(
                    items.filter((x) => picked.has(x.id)),
                    [],
                    parseTags(tagText),
                  ).then(() => setTagText(''))
                }
              >
                Remove tags
              </button>
            </div>
          ) : null}
          {shown.length === 0 && tag ? <p className="mute">No source has the tag {tag}.</p> : null}
          <ul className="sources">
            {shown.map((s) => (
              <li key={s.id}>
                <SourceCard
                  s={s}
                  notebookId={notebookId}
                  onTag={(t) => setTag((cur) => (cur?.toLowerCase() === t.toLowerCase() ? null : t))}
                  activeTag={tag}
                  selecting={selecting}
                  selected={picked.has(s.id)}
                  onSelect={(on) =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <AddSources notebookId={notebookId} open={adding} onOpenChange={setAdding} />
    </div>
  );
}
