/**
 * GD1: every guide article has one shape, every section can be cited, every
 * "related" link and every glossary link lands somewhere real, and the guide
 * says nothing about UI that has been removed or behaviour that has changed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARTICLES,
  articleById,
  CHAPTERS,
  citeGuide,
  ERROR_ARTICLES,
  sectionsOf,
  slugOf,
} from '../src/help/articles';
import { GLOSSARY } from '../src/help/glossary';
import { loadGuide } from '../src/help/lazyGuide';
import { TOURS } from '../src/help/tours';

beforeAll(async () => {
  await loadGuide();
});

const parse = (ref: string) => {
  const at = ref.indexOf('#');
  return at < 0 ? { id: ref, section: undefined } : { id: ref.slice(0, at), section: ref.slice(at + 1) };
};

describe('the shape of every article', () => {
  it('has a title, a one-line summary and a unique id', () => {
    const ids = new Set<string>();
    for (const a of ARTICLES) {
      expect(ids.has(a.id), `duplicate id ${a.id}`).toBe(false);
      ids.add(a.id);
      expect(a.title.length, a.id).toBeGreaterThan(2);
      expect(a.summary, a.id).not.toContain('\n');
      expect(a.summary.length, a.id).toBeLessThan(140);
      expect(a.summary.trim().endsWith('.'), `${a.id}: summary ends with a full stop`).toBe(true);
    }
  });

  it('opens with a lead paragraph, then ### sections with unique anchors', () => {
    for (const a of ARTICLES) {
      expect(a.body.trimStart().startsWith('#'), `${a.id} starts with a heading`).toBe(false);
      expect(/^#{1,2}\s/m.test(a.body), `${a.id} uses # or ## inside the body`).toBe(false);
      expect(/^#{4,}\s/m.test(a.body), `${a.id} uses #### or deeper`).toBe(false);
      const ids = sectionsOf(a.body).map((s) => s.id);
      expect(new Set(ids).size, `${a.id} has repeated section anchors`).toBe(ids.length);
      for (const s of sectionsOf(a.body)) expect(s.id, `${a.id}: ${s.title}`).toBe(slugOf(s.title));
    }
  });

  it('splits an article of any length into sections', () => {
    for (const a of ARTICLES) {
      if (a.id === 'glossary') continue;
      if (a.body.length > 900)
        expect(sectionsOf(a.body).length, `${a.id} (${a.body.length} characters)`).toBeGreaterThanOrEqual(2);
    }
  });

  it('puts "What NVX Ancile does" and "Good to know" in the same place in every article', () => {
    for (const a of ARTICLES) {
      const ids = sectionsOf(a.body).map((s) => s.id);
      const does = ids.findIndex((i) => i.startsWith('what-nvx-ancile-does'));
      const know = ids.indexOf('good-to-know');
      if (does >= 0 && know >= 0 && a.sources === undefined)
        expect(does, `${a.id}: What NVX Ancile does comes before Good to know`).toBeLessThan(know);
      if (does >= 0 && a.sources)
        expect(ids.at(-1), `${a.id}: an article with sources ends with what it does`).toBe(ids[does]);
      if (know >= 0) expect(ids.at(-1), `${a.id}: Good to know is last`).toBe('good-to-know');
    }
  });

  it('lists its sources with a date whenever it has any', () => {
    for (const a of ARTICLES.filter((x) => x.sources)) {
      expect(a.checked, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const s of a.sources ?? []) expect(s.url, a.id).toMatch(/^https?:\/\//);
    }
  });

  it('follows the copy rules: no em dashes, no carriage returns, no hype', () => {
    for (const a of ARTICLES) {
      const text = `${a.title}\n${a.summary}\n${a.body}`;
      expect(text, a.id).not.toContain('—');
      expect(text, a.id).not.toContain('\r');
      expect(text, a.id).not.toMatch(
        /\b(revolutionary|seamless|game-changing|blazing|supercharge|unleash)\b/i,
      );
    }
  });
});

describe('every section can be cited', () => {
  it('points citeGuide at each section of each article', () => {
    for (const a of ARTICLES)
      for (const s of sectionsOf(a.body)) {
        const c = citeGuide(a.id, s.id);
        expect(c?.section, `${a.id}#${s.id}`).toBe(s.title);
        expect(c?.url, `${a.id}#${s.id}`).toBe(`/open/help?topic=${encodeURIComponent(a.id)}#${s.id}`);
      }
    expect(citeGuide('models', 'no-such-section')).toBeNull();
  });

  it('resolves every related link, to an article or to one of its sections', () => {
    for (const a of ARTICLES)
      for (const ref of a.related ?? []) {
        const { id, section } = parse(ref);
        expect(id, `${a.id} relates to itself`).not.toBe(a.id);
        const found = articleById(id);
        expect(found, `${a.id} -> ${ref}`).not.toBeNull();
        if (section)
          expect(
            sectionsOf(found?.article.body ?? '').some((s) => s.id === section),
            `${a.id} -> ${ref}`,
          ).toBe(true);
      }
  });

  it('gives every article something to read next', () => {
    const core = CHAPTERS.filter((c) => c.id !== 'providers').flatMap((c) => c.articles);
    for (const a of core) if (a.id !== 'glossary') expect(a.related?.length, a.id).toBeGreaterThan(0);
  });

  it('points every error code at an article that exists', () => {
    for (const [code, ref] of Object.entries(ERROR_ARTICLES)) {
      const { id, section } = parse(ref);
      const found = articleById(id);
      expect(found, code).not.toBeNull();
      if (section)
        expect(
          sectionsOf(found?.article.body ?? '').some((s) => s.id === section),
          code,
        ).toBe(true);
    }
  });
});

describe('the glossary', () => {
  it('has unique ids and sends every term to a real article and section', () => {
    const ids = new Set<string>();
    for (const g of GLOSSARY) {
      expect(ids.has(g.id), `duplicate ${g.id}`).toBe(false);
      ids.add(g.id);
      if (g.article) {
        const found = articleById(g.article);
        expect(found, g.id).not.toBeNull();
        if (g.section)
          expect(
            sectionsOf(found?.article.body ?? '').some((s) => s.id === g.section),
            `${g.id}#${g.section}`,
          ).toBe(true);
      }
    }
  });

  it('has the words 0.1.1 brought in', () => {
    for (const id of [
      'tier',
      'decision-model',
      'free-allowance',
      'verdict-cache',
      'standard',
      'passive-memory',
      'fit-line',
      'who-answers',
      'triage',
      'critical-check',
      'summary-level',
      'by-purpose',
    ])
      expect(
        GLOSSARY.some((g) => g.id === id),
        id,
      ).toBe(true);
  });

  it('shows each term in the article that explains it, and in the Words used here page', () => {
    const page = articleById('glossary')?.article.body ?? '';
    for (const g of GLOSSARY) expect(page, g.id).toContain(`**${g.term}**`);
    const explained = new Set(GLOSSARY.map((g) => g.article).filter(Boolean));
    expect(explained.size).toBeGreaterThan(10);
  });
});

describe('what the guide says about the product now', () => {
  // The core chapters, read after the guide has loaded.
  const guideText = () =>
    CHAPTERS.filter((c) => c.id !== 'providers')
      .flatMap((c) => c.articles)
      .map((a) => `${a.id}\n${a.title}\n${a.body}`)
      .join('\n====\n');

  it('does not mention UI that was removed', () => {
    const text = guideText();
    expect(text).not.toMatch(/FlowChip|ModelChoice/);
    expect(text).not.toMatch(/which did you mean/i);
    expect(text).not.toMatch(/this message, this thread or the flow/i);
  });

  it('does not say web search needs SearXNG, or that fact-check needs a listed model', () => {
    const text = guideText();
    expect(text).not.toMatch(/SEARXNG_URL/);
    expect(text).not.toMatch(/web search needs/i);
    expect(text).not.toMatch(/you (?:must|need to) list (?:a |the )?models? for/i);
    expect(text).not.toMatch(/no second opinion/i);
  });

  it('does not name old models as defaults', () => {
    const text = guideText();
    expect(text).not.toMatch(/GPT-5\.5|Gemini 3 Pro|Haiku 4\.5/);
  });

  it('names the new surfaces by their real labels', () => {
    const text = guideText();
    for (const label of [
      'Who answers',
      'Settings → Decisions',
      'Settings → Private notebooks',
      'Switch and summarise',
      'Check this on the web',
      'Not checked',
      'Compare with a standard',
      'Update memory',
      'Used:',
      'By purpose',
      'Try with',
    ])
      expect(text, label).toContain(label);
  });

  it('keeps every guide chapter in the guide once it has loaded', () => {
    expect(CHAPTERS.map((c) => c.id)).toEqual([
      'start',
      'notebooks',
      'lab',
      'compute',
      'keys',
      'memory',
      'running',
      'yours',
      'extras',
      'trouble',
      'flows',
      'providers',
    ]);
  });
});

describe('every tour', () => {
  it('has steps with a title and a body in the house voice', () => {
    for (const t of Object.values(TOURS)) {
      expect(t.steps.length, t.id).toBeGreaterThan(0);
      for (const s of t.steps) {
        const words = `${s.title} ${s.body} ${s.absent ?? ''}`;
        expect(words, `${t.id}: ${s.title}`).not.toContain('—');
        expect(s.body.length, `${t.id}: ${s.title}`).toBeLessThan(330);
        expect(s.title.length, `${t.id}: ${s.title}`).toBeLessThan(60);
      }
    }
  });

  it('offers the 0.1.1 tours, and every article that names a tour names a real one', () => {
    for (const id of ['whats-new', 'decisions', 'private-notebooks', 'fact-check', 'memory'])
      expect(TOURS[id], id).toBeDefined();
    for (const a of ARTICLES) if (a.tour) expect(TOURS[a.tour], a.id).toBeDefined();
    expect(articleById('whats-new')?.article.tour).toBe('whats-new');
  });
});

describe('the files stay LF', () => {
  it('has no carriage returns in the guide sources', () => {
    for (const f of ['articles.ts', 'coreGuide.ts', 'glossary.ts', 'tours.ts'])
      expect(readFileSync(resolve(__dirname, '../src/help', f), 'utf8'), f).not.toContain('\r');
  });
});
