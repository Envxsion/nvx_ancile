/**
 * GD1: the "Providers and paying" chapter. It loads on demand (not in the first
 * download), its sections have stable anchors, every article cites its sources,
 * facts not yet confirmed are marked, and citeGuide points at a real place.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARTICLES,
  articleById,
  CHAPTERS,
  citeGuide,
  markUnconfirmed,
  NOT_CONFIRMED_HREF,
  searchHelp,
  sectionsOf,
  slugOf,
} from '../src/help/articles';
import { HelpCentre } from '../src/help/HelpCentre';
import { guideLoaded, loadGuide } from '../src/help/lazyGuide';
import { useUi } from '../src/state/ui';

const PROVIDER_IDS = [
  'prov-anthropic',
  'prov-openai',
  'prov-google',
  'prov-xai',
  'prov-mistral',
  'prov-cohere',
  'prov-perplexity',
  'prov-deepseek',
  'prov-moonshot',
  'prov-minimax',
  'prov-alibaba',
  'prov-zai',
  'prov-openrouter',
  'prov-fast-hosts',
  'prov-cloudflare',
  'prov-huggingface',
  'prov-ollama',
  'prov-lmstudio',
  'prov-runpod',
  'prov-claude-code',
  'prov-coding-clis',
];
const CROSS_IDS = [
  'pay-ways',
  'balance-order',
  'subscription-terms',
  'chat-storage',
  'free-data',
  'caching-by-provider',
  'regions-endpoints',
  'errors-alike',
];

describe('the guide before the chapter loads', () => {
  it('does not carry the chapter in its first lists', () => {
    expect(guideLoaded()).toBe(false);
    expect(CHAPTERS.some((c) => c.id === 'providers')).toBe(false);
    expect(articleById('pay-ways')).toBeNull();
    expect(searchHelp('prompt caching by provider').some((a) => a.id === 'caching-by-provider')).toBe(false);
    expect(citeGuide('pay-ways')).toBeNull();
  });
});

describe('the Providers and paying chapter', () => {
  beforeAll(async () => {
    await loadGuide();
  });

  it('loads on demand, once, and joins the guide', async () => {
    expect(guideLoaded()).toBe(true);
    const before = ARTICLES.length;
    await loadGuide();
    expect(ARTICLES.length).toBe(before);
    const chapter = CHAPTERS.find((c) => c.id === 'providers');
    expect(chapter?.title).toBe('Providers and paying');
    expect(chapter?.articles.map((a) => a.id)).toEqual([...CROSS_IDS, ...PROVIDER_IDS]);
    expect(articleById('prov-deepseek')?.chapter.id).toBe('providers');
  });

  it('puts the cross-cutting questions first and groups the small hosts', () => {
    const ids = CHAPTERS.find((c) => c.id === 'providers')?.articles.map((a) => a.id) ?? [];
    expect(ids.slice(0, CROSS_IDS.length)).toEqual(CROSS_IDS);
    const hosts = articleById('prov-fast-hosts')?.article;
    expect(hosts?.title).toBe('Fast inference hosts: Groq, Together, Fireworks and Cerebras');
    for (const n of ['Groq', 'Together', 'Fireworks', 'Cerebras']) expect(hosts?.body).toContain(`### ${n}`);
  });

  it('gives sections stable anchors', () => {
    expect(slugOf('What NVX Ancile does about it')).toBe('what-nvx-ancile-does-about-it');
    expect(slugOf('Off-peak prices')).toBe('off-peak-prices');
    expect(sectionsOf('### One\ntext\n### One\n### Two words')).toEqual([
      { id: 'one', title: 'One' },
      { id: 'one-2', title: 'One' },
      { id: 'two-words', title: 'Two words' },
    ]);
    const deepseek = articleById('prov-deepseek')?.article;
    expect(sectionsOf(deepseek?.body ?? '').map((s) => s.id)).toEqual([
      'paying',
      'off-peak-prices',
      'caching',
      'limits-and-errors',
      'your-data',
      'terms-and-endpoint',
      'what-nvx-ancile-does-about-it',
    ]);
    for (const a of ARTICLES.filter((x) => x.sources)) {
      const ids = sectionsOf(a.body).map((s) => s.id);
      expect(new Set(ids).size, a.id).toBe(ids.length);
      expect(ids.at(-1), a.id).toBe('what-nvx-ancile-does-about-it');
    }
  });

  it('lists the sources and the date for every article', () => {
    for (const a of ARTICLES.filter((x) => PROVIDER_IDS.includes(x.id) || CROSS_IDS.includes(x.id))) {
      expect(a.sources?.length, a.id).toBeGreaterThan(0);
      for (const s of a.sources ?? []) {
        expect(s.title, a.id).not.toBe('');
        expect(s.url, a.id).toMatch(/^https?:\/\//);
      }
      expect(a.checked, a.id).toBe('2026-10-20');
    }
  });

  it('follows the copy rules: no em dashes, no carriage returns, no hype', () => {
    for (const a of ARTICLES.filter((x) => x.sources)) {
      const text = `${a.title}\n${a.summary}\n${a.body}`;
      expect(text, a.id).not.toContain('—');
      expect(text, a.id).not.toContain('\r');
      expect(text, a.id).not.toMatch(/\b(revolutionary|seamless|game-changing|blazing)\b/i);
    }
  });

  it('marks every unconfirmed sentence, and only those', () => {
    let marks = 0;
    for (const a of ARTICLES.filter((x) => x.unconfirmed?.length)) {
      for (const u of a.unconfirmed ?? []) expect(a.body, `${a.id}: ${u}`).toContain(u);
      const marked = markUnconfirmed(a.body, a.unconfirmed);
      const n = marked.split(`](${NOT_CONFIRMED_HREF})`).length - 1;
      expect(n, a.id).toBe(a.unconfirmed?.length);
      marks += n;
    }
    expect(marks).toBeGreaterThan(20);
    expect(markUnconfirmed('One. Two.', ['One.'])).toBe(
      `One. [Not yet confirmed](${NOT_CONFIRMED_HREF}) Two.`,
    );
    expect(markUnconfirmed('### Part\nText.', ['part'])).toContain(
      'Facts in this section are not yet confirmed.',
    );
  });

  it('is found by provider names and by the way people ask', () => {
    const top = (q: string) => searchHelp(q).map((a) => a.id);
    expect(top('does deepseek train on my data')).toContain('prov-deepseek');
    expect(top('does deepseek train on my data')).toContain('free-data');
    expect(top('free tier')).toEqual(expect.arrayContaining(['free-data', 'pay-ways']));
    expect(top('out of credit')).toEqual(expect.arrayContaining(['errors-alike']));
    expect(top('Kimi')).toContain('prov-moonshot');
    expect(top('Groq')).toContain('prov-fast-hosts');
    expect(top('Cerebras')).toContain('prov-fast-hosts');
    expect(top('Together')).toContain('prov-fast-hosts');
    expect(top('Fireworks')).toContain('prov-fast-hosts');
    expect(top('Qwen')).toContain('prov-alibaba');
    expect(top('GLM')).toContain('prov-zai');
    expect(top('Claude subscription')).toContain('pay-ways');
    expect(top('Included monthly credit')).toContain('prov-anthropic');
  });

  it('names the three Claude routes in NVX Ancile words', () => {
    const body = articleById('pay-ways')?.article.body ?? '';
    expect(body).toContain('**Claude subscription**');
    expect(body).toContain('**Included monthly credit**');
    expect(body).toContain('**Pay as you go**');
    expect(body).toContain(
      "When you're signed in with your Claude plan instead, claude -p and Agent SDK usage still draw from your plan's usage limits and don't use your API credits.",
    );
    expect(articleById('pay-ways')?.article.sources?.map((s) => s.url)).toContain(
      'https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans',
    );
  });
});

describe('citeGuide', () => {
  beforeAll(async () => {
    await loadGuide();
  });

  it('points at an article, or at a section of it, with the in-app route', () => {
    expect(citeGuide('prov-deepseek')).toEqual({
      title: 'DeepSeek',
      section: null,
      url: '/open/help?topic=prov-deepseek',
      checked: '2026-10-20',
    });
    expect(citeGuide('prov-deepseek', 'off-peak-prices')).toEqual({
      title: 'DeepSeek',
      section: 'Off-peak prices',
      url: '/open/help?topic=prov-deepseek#off-peak-prices',
      checked: '2026-10-20',
    });
  });

  it('works for the guide that is always loaded, with no date', () => {
    expect(citeGuide('welcome')).toEqual({
      title: 'What NVX Ancile is',
      section: null,
      url: '/open/help?topic=welcome',
      checked: null,
    });
  });

  it('never points nowhere', () => {
    expect(citeGuide('no-such-article')).toBeNull();
    expect(citeGuide('prov-deepseek', 'no-such-section')).toBeNull();
  });
});

describe('the help centre shows the chapter', () => {
  beforeAll(async () => {
    await loadGuide();
  });

  it('draws the sources list, the not-yet-confirmed mark and section anchors', async () => {
    act(() => useUi.getState().setHelp(true, 'prov-mistral'));
    render(<HelpCentre />);
    expect(await screen.findByRole('heading', { name: 'Mistral', level: 2 })).toBeTruthy();
    await waitFor(() => expect(document.getElementById('caching')).not.toBeNull());
    expect(document.getElementById('what-nvx-ancile-does-about-it')?.tagName).toBe('H3');
    expect(await screen.findByText('Sources, checked 20 Oct 2026')).toBeTruthy();
    expect(screen.getAllByText('Not yet confirmed').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.help__sources li').length).toBeGreaterThan(0);
    act(() => useUi.getState().setHelp(false));
  });
});
