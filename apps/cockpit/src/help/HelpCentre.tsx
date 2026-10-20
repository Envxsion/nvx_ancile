/**
 * ------------------------------------------------------------------
 *  Title    |  Help centre
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The guide, beside your work rather than instead of it:
 *           |  search, chapters, tours that show the real screen, and
 *           |  every article a click from the error that needs it.
 *  How      |  A Radix dialog drawn as a glass sheet from the right,
 *           |  so the screen it explains stays visible behind it.
 *           |  Articles render with Streamdown like answers do.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, m as motion } from 'motion/react';
import {
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBinding, useLayer } from '../keys/dispatch';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { Kbd } from '../ui/primitives';
import { LINK_COMPONENTS, SafeLink } from '../ui/SafeLink';
import {
  ARTICLES,
  type Article,
  articleById,
  CHAPTERS,
  markUnconfirmed,
  NOT_CONFIRMED_HREF,
  searchHelp,
  sectionsOf,
  slugOf,
} from './articles';
import { loadGuide, useGuideLoaded } from './lazyGuide';
import { useHelp } from './store';
import { TOURS } from './tours';

/** "20 Oct 2026" for an ISO date. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** "article#section" to its parts. */
function parseRef(ref: string): { id: string; section: string | null } {
  const at = ref.indexOf('#');
  return at < 0 ? { id: ref, section: null } : { id: ref.slice(0, at), section: ref.slice(at + 1) || null };
}

/** Markdown parts for an article: section anchors on ### headings and the quiet "Not yet confirmed" label. */
function guideComponents(article: Article) {
  const ids = new Map<string, string>();
  for (const s of sectionsOf(article.body)) if (!ids.has(s.title)) ids.set(s.title, s.id);
  return {
    ...LINK_COMPONENTS,
    a: (props: ComponentProps<'a'>) =>
      props.href === NOT_CONFIRMED_HREF ? (
        <span className="help__nyc" title="This has not been confirmed at the vendor's own page.">
          {props.children}
        </span>
      ) : (
        <SafeLink {...props} />
      ),
    h3: ({ children }: ComponentProps<'h3'>) => {
      const text = textOf(children);
      return <h3 id={ids.get(text) ?? slugOf(text)}>{children}</h3>;
    },
  };
}

function ArticleView({ article, onOpen }: { article: Article; onOpen: (id: string) => void }) {
  const i = ARTICLES.findIndex((a) => a.id === article.id);
  const prev = ARTICLES[i - 1];
  const next = ARTICLES[i + 1];
  const startTour = useHelp((s) => s.startTour);
  const setHelp = useUi((s) => s.setHelp);
  const tour = article.tour ? TOURS[article.tour] : undefined;
  const components = useMemo(() => guideComponents(article), [article]);
  const body = useMemo(() => markUnconfirmed(article.body, article.unconfirmed), [article]);
  return (
    <article className="help__article">
      <p className="help__crumb">{articleById(article.id)?.chapter.title}</p>
      <h2 className="help__title" data-display>
        {article.title}
      </h2>
      <p className="help__summary">{article.summary}</p>
      {tour ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm help__tour-btn"
          onClick={() => {
            setHelp(false);
            startTour(tour.id);
          }}
        >
          <Icon name="play" size={12} />
          Show me on screen
          <span className="mute">· {tour.steps.length} steps</span>
        </button>
      ) : null}
      <Markdown className="md help__body" controls={false} mode="static" components={components}>
        {body}
      </Markdown>
      {article.sources?.length ? (
        <footer className="help__sources">
          <h3 className="help__sources-h">
            {article.checked ? `Sources, checked ${shortDate(article.checked)}` : 'Sources'}
          </h3>
          <ul>
            {article.sources.map((src) => (
              <li key={src.url}>
                <SafeLink href={src.url}>{src.title}</SafeLink>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
      <nav className="help__pager" aria-label="More articles">
        {prev ? (
          <button type="button" className="help__page" onClick={() => onOpen(prev.id)}>
            <span className="mute">Previous</span>
            <span>{prev.title}</span>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button type="button" className="help__page help__page--next" onClick={() => onOpen(next.id)}>
            <span className="mute">Next</span>
            <span>{next.title}</span>
          </button>
        ) : null}
      </nav>
    </article>
  );
}

function Contents({ onOpen, query }: { onOpen: (id: string) => void; query: string }) {
  const tours = useHelp((s) => s.tours);
  const startTour = useHelp((s) => s.startTour);
  const setHelp = useUi((s) => s.setHelp);
  const loaded = useGuideLoaded();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lazy chapter adds articles once it loads
  const results = useMemo(() => searchHelp(query), [query, loaded]);

  if (query.trim())
    return (
      <div className="help__results">
        {results.length === 0 ? (
          <p className="help__none">
            Nothing in the guide for “{query}”. Try fewer words, or press <Kbd keys="mod+k" /> to search your
            threads.
          </p>
        ) : (
          <ul>
            {results.map((a) => (
              <li key={a.id}>
                <button type="button" className="help__result" onClick={() => onOpen(a.id)}>
                  <span className="help__result-title">{a.title}</span>
                  <span className="mute">{a.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  return (
    <div className="help__contents">
      <section className="help__tours" aria-labelledby="help-tours">
        <h3 id="help-tours" className="help__h">
          Tours
        </h3>
        <ul className="help__tour-list">
          {Object.values(TOURS).map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="help__tour"
                onClick={() => {
                  setHelp(false);
                  startTour(t.id);
                }}
              >
                <span className="help__tour-icon">
                  <Icon name={tours[t.id] === 'done' ? 'check' : 'play'} size={13} />
                </span>
                <span className="help__tour-text">
                  <span>{t.title}</span>
                  <span className="mute">
                    {t.steps.length} steps, about {t.minutes} min
                    {tours[t.id] === 'done' ? ' · done' : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {CHAPTERS.map((c, ci) => (
        <section key={c.id} className="help__chapter" aria-labelledby={`help-ch-${c.id}`}>
          <h3 id={`help-ch-${c.id}`} className="help__h">
            <span className="help__numeral" aria-hidden="true">
              {String(ci + 1).padStart(2, '0')}
            </span>
            {c.title}
          </h3>
          <ul>
            {c.articles.map((a) => (
              <li key={a.id}>
                <button type="button" className="help__link" onClick={() => onOpen(a.id)}>
                  <span>{a.title}</span>
                  <Icon name="chevronRight" size={12} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function HelpCentre() {
  const open = useUi((s) => s.helpOpen);
  const initial = useUi((s) => s.helpArticle);
  const setHelp = useUi((s) => s.setHelp);
  const [stack, setStack] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const loaded = useGuideLoaded();
  useLayer(open);
  useBinding('help.open', () => setHelp(true));

  // The "Providers and paying" chapter is not in the first download: fetch it as the guide opens.
  useEffect(() => {
    if (open) void loadGuide().catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (open) {
      setStack(initial ? [initial] : []);
      setQuery('');
    }
  }, [open, initial]);

  const topRef = stack.length ? parseRef(stack[stack.length - 1] ?? '') : null;
  const current = topRef ? articleById(topRef.id)?.article : undefined;
  const section = current ? (topRef?.section ?? null) : null;
  const waiting = !!topRef && !current && !loaded;
  const openArticle = (ref: string) => {
    setStack((s) => [...s, ref]);
    setQuery('');
    if (!parseRef(ref).section)
      requestAnimationFrame(() => document.querySelector('.help__scroll')?.scrollTo({ top: 0 }));
  };

  // A citation can name a section ("article#section"): scroll to it once the article has drawn.
  useEffect(() => {
    if (!open || !current || !section || query) return;
    let tries = 0;
    let frame = 0;
    const tick = () => {
      const el = document.getElementById(section);
      if (el) el.scrollIntoView({ block: 'start' });
      else if (tries++ < 40) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, current, section, query]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => setHelp(o)}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="help-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                searchRef.current?.focus();
              }}
            >
              <motion.div
                className="help m-glass-thick"
                initial={{ x: 40, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 30, opacity: 0, transition: { duration: 0.16 } }}
                transition={spring.smooth}
              >
                <header className="help__head">
                  {current ? (
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      aria-label="Back"
                      onClick={() => setStack((s) => s.slice(0, -1))}
                    >
                      <Icon name="chevronLeft" size={14} />
                    </button>
                  ) : (
                    <span className="help__mark">
                      <Icon name="book" size={15} />
                    </span>
                  )}
                  <Dialog.Title className="help__head-title">
                    {current ? 'Guide' : 'NVX Ancile guide'}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="icon-btn icon-btn--sm" aria-label="Close the guide">
                      <Icon name="close" size={14} />
                    </button>
                  </Dialog.Close>
                </header>
                <label className="help__search">
                  <Icon name="search" size={14} />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (e.target.value) setStack([]);
                    }}
                    placeholder="Search the guide"
                    aria-label="Search the guide"
                  />
                </label>
                <div className="help__scroll" data-scrollable>
                  {waiting && !query ? (
                    <p className="help__none">Loading this article.</p>
                  ) : current && !query ? (
                    <ArticleView article={current} onOpen={openArticle} />
                  ) : (
                    <Contents onOpen={openArticle} query={query} />
                  )}
                </div>
                <footer className="help__foot">
                  <span className="mute">
                    <Kbd keys="g h" /> opens this guide, <Kbd keys="?" /> lists every key
                  </span>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
