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
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { useBinding, useLayer } from '../keys/dispatch';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Kbd } from '../ui/primitives';
import { ARTICLES, type Article, articleById, CHAPTERS, searchHelp } from './articles';
import { useHelp } from './store';
import { TOURS } from './tours';

function ArticleView({ article, onOpen }: { article: Article; onOpen: (id: string) => void }) {
  const i = ARTICLES.findIndex((a) => a.id === article.id);
  const prev = ARTICLES[i - 1];
  const next = ARTICLES[i + 1];
  const startTour = useHelp((s) => s.startTour);
  const setHelp = useUi((s) => s.setHelp);
  const tour = article.tour ? TOURS[article.tour] : undefined;
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
      <Streamdown className="md help__body" controls={false} mode="static">
        {article.body}
      </Streamdown>
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
  const results = useMemo(() => searchHelp(query), [query]);

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
  useLayer(open);
  useBinding('help.open', () => setHelp(true));

  useEffect(() => {
    if (open) {
      setStack(initial ? [initial] : []);
      setQuery('');
    }
  }, [open, initial]);

  const current = stack.length ? articleById(stack[stack.length - 1] ?? '')?.article : undefined;
  const openArticle = (id: string) => {
    setStack((s) => [...s, id]);
    setQuery('');
    requestAnimationFrame(() => document.querySelector('.help__scroll')?.scrollTo({ top: 0 }));
  };

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
                  {current && !query ? (
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
