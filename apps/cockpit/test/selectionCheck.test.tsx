/**
 * Roadmap FC3 in the Cockpit: highlight words in a message and a bar offers
 * Fact-check (anywhere in a message, by mouse, keyboard or context menu); the
 * card shows a one-line verdict, the corrected claim, evidence with its
 * sources, one closing line and the cost; "Use the corrected claim" writes a
 * follow-up in the composer and never sends it; a refusal (GR24) is said
 * plainly. Also EV1 (claims appear as they are found), EV2 (what retrieval
 * found) and the record on the Evidence tab and the receipt.
 */
import type { SelectionCheck } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const params = vi.hoisted(() => ({}) as Record<string, string | undefined>);
const nav = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => params,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/',
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});
vi.mock('../src/router', () => ({ router: { navigate: nav.navigate } }));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { EvidencePanel } from '../src/drawer/EvidencePanel';
import { ApiCallError, api, localError } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { useFactcheckProgress } from '../src/lib/factcheck';
import { queryClient } from '../src/lib/query';
import { fold, type LiveTurn } from '../src/lib/run';
import type { ThreadView } from '../src/lib/types';
import { buildSteps, searchDetail, searchedLabel, searchFactsOf } from '../src/receipt/figures';
import { useSelectionCheck } from '../src/state/selectionCheck';
import { useUi } from '../src/state/ui';
import { Composer } from '../src/thread/Composer';
import { FactcheckCard, placeCard } from '../src/thread/FactcheckCard';
import { SearchedLine } from '../src/thread/LiveFooter';
import { barPosition, SelectionToolbar } from '../src/thread/SelectionToolbar';
import { useHighlight } from '../src/thread/useHighlight';

const post = vi.mocked(api.post);
const get = vi.mocked(api.get);

const RECT = { left: 100, top: 200, right: 260, bottom: 220, width: 160, height: 20 } as DOMRect;

beforeEach(() => {
  // jsdom lays nothing out: a range has no box until we give it one.
  Range.prototype.getBoundingClientRect = () => RECT;
  Element.prototype.scrollIntoView = vi.fn();
  post.mockReset();
  get.mockReset();
  for (const k of Object.keys(params)) delete params[k];
  useUi.setState({ demo: false, focusedCheck: null, evidenceMessage: null });
  useSelectionCheck.setState({ toolbar: null, card: null });
  useFactcheckProgress.setState({ byMessage: {}, claims: {} });
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  queryClient.clear();
});

const check = (over: Partial<SelectionCheck> = {}): SelectionCheck => ({
  id: 'sck_1',
  message_id: 'm_1',
  text: 'Error code E-17 means the impeller is blocked.',
  char_start: 0,
  char_end: 46,
  kind: 'prose',
  written_by_family: 'openai',
  verdict: 'doesnt_hold',
  headline: 'The manual lists E-19 for a blocked impeller, not E-17.',
  corrected: 'Error code E-19 means the impeller is blocked.',
  evidence: [
    {
      text: 'The manual lists E-19 for a blocked impeller.',
      origin: 'source',
      source: 'Pump manual, p. 2',
      source_id: 'src_manual',
      url: null,
      stance: 'contradicts',
    },
    {
      text: 'Pump makers publish impeller codes.',
      origin: 'web',
      source: 'Pump facts',
      source_id: null,
      url: 'https://pumps.example/codes',
      stance: 'supports',
    },
    {
      text: 'No E-17 code exists for this model.',
      origin: 'model',
      source: 'Model knowledge',
      source_id: null,
      url: null,
      stance: 'neutral',
    },
  ],
  closing: 'The advice to look for E-17 would change to E-19.',
  checker_model_id: 'google/gemini-pro',
  checker_family: 'google',
  cost_usd: 0.0021,
  billed: 'key',
  web: { used: true, note: null },
  ran: null,
  created_at: '2026-10-19T03:00:00.000Z',
  ...over,
});

const highlight = {
  messageId: 'm_1',
  threadId: 'thr_1',
  text: 'Error code E-17 means the impeller is blocked.',
  box: { left: 100, top: 200, right: 260, bottom: 220 },
  range: null,
  via: 'select' as const,
  at: null,
};

/** A message body with words in it, wired to the highlight hook as Message.tsx wires it. */
function Body({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useHighlight(ref, { messageId: 'm_1', threadId: 'thr_1', enabled });
  return (
    <article ref={ref}>
      <div className="msg__body">
        <p data-testid="words">Error code E-17 means the impeller is blocked. Owls are nocturnal.</p>
        <pre>
          <code data-testid="code">print(1 + 1)</code>
        </pre>
      </div>
      <button type="button">Copy</button>
      <SelectionToolbar messageId="m_1" />
    </article>
  );
}

function select(node: Node, from = 0, to?: number) {
  const range = document.createRange();
  const text = node.firstChild ?? node;
  range.setStart(text, from);
  range.setEnd(text, to ?? text.textContent?.length ?? 0);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return range;
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 5)));

describe('the bar beside a highlight', () => {
  it('appears over words highlighted in a message, named for screen readers, and does nothing yet', async () => {
    render(<Body />);
    select(screen.getByTestId('words'), 0, 46);
    fireEvent.mouseUp(screen.getByTestId('words'));
    await tick();
    const bar = screen.getByRole('toolbar', { name: 'Highlighted text' });
    const button = within(bar).getByRole('button', { name: /Fact-check/ });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'F');
    // Nothing is asked, and nothing is spent, until the button is pressed.
    expect(post).not.toHaveBeenCalled();
    expect(useSelectionCheck.getState().card).toBeNull();
  });

  it('is not shown for a click, for words outside the message body, or for a message that cannot be checked', async () => {
    const { rerender } = render(<Body />);
    select(screen.getByTestId('words'), 0, 2);
    fireEvent.mouseUp(screen.getByTestId('words'));
    await tick();
    expect(screen.queryByRole('toolbar')).toBeNull();

    select(screen.getByText('Copy'));
    fireEvent.mouseUp(screen.getByText('Copy'));
    await tick();
    expect(screen.queryByRole('toolbar')).toBeNull();

    rerender(<Body enabled={false} />);
    select(screen.getByTestId('words'), 0, 20);
    fireEvent.mouseUp(screen.getByTestId('words'));
    await tick();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('takes a keyboard highlight too (Shift and the arrows), and Escape puts it away', async () => {
    render(<Body />);
    select(screen.getByTestId('words'), 0, 20);
    fireEvent.keyUp(screen.getByTestId('words'), { key: 'ArrowRight', shiftKey: true });
    await tick();
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    fireEvent.keyUp(screen.getByTestId('words'), { key: 'Escape' });
    await tick();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('says what the words are inside: a code block is code', async () => {
    render(<Body />);
    select(screen.getByTestId('code'));
    fireEvent.mouseUp(screen.getByTestId('code'));
    await tick();
    expect(useSelectionCheck.getState().toolbar).toMatchObject({ text: 'print(1 + 1)', kind: 'code' });
  });

  it('stands in for the context menu on a highlight, with Copy beside Fact-check', async () => {
    render(<Body />);
    select(screen.getByTestId('words'), 0, 20);
    const prevented = !fireEvent.contextMenu(screen.getByTestId('words'), { clientX: 140, clientY: 230 });
    await tick();
    expect(prevented).toBe(true);
    const bar = screen.getByRole('toolbar');
    expect(bar).toHaveAttribute('data-via', 'menu');
    expect(within(bar).getByRole('button', { name: /Copy/ })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /Fact-check/ })).toBeInTheDocument();
  });

  it('opens the card for the highlight when Fact-check is pressed, and the bar goes', async () => {
    render(<Body />);
    select(screen.getByTestId('words'), 0, 46);
    fireEvent.mouseUp(screen.getByTestId('words'));
    await tick();
    fireEvent.click(screen.getByRole('button', { name: /Fact-check/ }));
    const card = useSelectionCheck.getState().card;
    expect(card).toMatchObject({ messageId: 'm_1', text: 'Error code E-17 means the impeller is blocked.' });
    expect(useSelectionCheck.getState().toolbar).toBeNull();
  });

  it('sits over the highlight, under it when there is no room above, and stays on screen', () => {
    const size = { w: 120, h: 32 };
    const view = { w: 800, h: 600 };
    const above = barPosition(
      { box: { left: 300, top: 200, right: 400, bottom: 220 }, via: 'select', at: null },
      size,
      view,
    );
    expect(above.top).toBeLessThan(200);
    const under = barPosition(
      { box: { left: 300, top: 10, right: 400, bottom: 30 }, via: 'select', at: null },
      size,
      view,
    );
    expect(under.top).toBeGreaterThan(30);
    const edge = barPosition(
      { box: { left: 780, top: 200, right: 800, bottom: 220 }, via: 'select', at: null },
      size,
      view,
    );
    expect(edge.left + size.w).toBeLessThanOrEqual(view.w);
  });
});

describe('the card', () => {
  it('shows the verdict, the corrected claim, sourced evidence, one closing line and the cost', async () => {
    post.mockResolvedValue({ check: check(), cached: false });
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    // Calm while it works, and it asks once.
    expect(screen.getByRole('status')).toHaveTextContent('Checking this claim');
    const card = await screen.findByRole('dialog', { name: 'Fact-check' });
    await screen.findByText("Doesn't hold");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/messages/m_1/selection-checks', {
      text: 'Error code E-17 means the impeller is blocked.',
    });
    expect(within(card).getByText('Corrected claim')).toBeInTheDocument();
    expect(within(card).getByText('Error code E-19 means the impeller is blocked.')).toBeInTheDocument();
    const lines = within(card).getAllByRole('listitem');
    expect(lines).toHaveLength(3);
    expect(within(lines[0] as HTMLElement).getByText('Source')).toBeInTheDocument();
    expect(within(lines[0] as HTMLElement).getByText('Pump manual, p. 2')).toBeInTheDocument();
    expect(within(lines[1] as HTMLElement).getByText('Web')).toBeInTheDocument();
    expect(within(lines[1] as HTMLElement).getByRole('link', { name: 'Pump facts' })).toHaveAttribute(
      'href',
      'https://pumps.example/codes',
    );
    expect(
      within(lines[2] as HTMLElement).getByText('Model knowledge', { selector: '.selev__origin' }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/The advice to look for E-17 would change to E-19\./)).toBeInTheDocument();
    // Who checked it and what it cost, with the receipt's money helper.
    expect(within(card).getByText(/Checked by .* · \$0\.0021/)).toBeInTheDocument();
    for (const name of ['Copy', 'Open in Evidence', 'Use the corrected claim'])
      expect(within(card).getByRole('button', { name })).toBeInTheDocument();
  });

  it('wears a semantic colour and a word for each verdict, never signal violet', async () => {
    for (const [verdict, label] of [
      ['holds', 'Holds'],
      ['partly', 'Partly holds'],
      ['cant_tell', "Can't tell"],
    ] as const) {
      useSelectionCheck.setState({ card: null });
      post.mockResolvedValue({ check: check({ verdict, corrected: null }), cached: false });
      useSelectionCheck.getState().openCard(highlight);
      const { unmount } = render(<FactcheckCard messageId="m_1" />);
      const chip = await screen.findByText(label);
      expect(chip.closest('.selverdict')).toHaveAttribute('data-verdict', verdict);
      expect(screen.queryByRole('button', { name: 'Use the corrected claim' })).toBeNull();
      unmount();
    }
  });

  it('writes the follow-up in the message box and never sends it', async () => {
    post.mockResolvedValue({ check: check(), cached: false });
    const inserted: { threadId: string; text: string }[] = [];
    window.addEventListener('ancile:composer-insert', (e) =>
      inserted.push((e as CustomEvent<{ threadId: string; text: string }>).detail),
    );
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use the corrected claim' }));
    expect(inserted).toEqual([
      {
        threadId: 'thr_1',
        text: "Let's start from this corrected claim: Error code E-19 means the impeller is blocked.\n\nHow does your answer change?",
      },
    ]);
    // The only request was the check itself: nothing was posted to the thread.
    expect(post.mock.calls.map((c) => c[0])).toEqual(['/messages/m_1/selection-checks']);
    expect(useSelectionCheck.getState().card).toBeNull();
  });

  it('opens the Evidence tab on its row', async () => {
    post.mockResolvedValue({ check: check(), cached: false });
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Evidence' }));
    expect(useUi.getState()).toMatchObject({
      drawerTab: 'evidence',
      evidenceMessage: 'm_1',
      focusedCheck: 'sck_1',
    });
  });

  it('copies the card as plain text', async () => {
    post.mockResolvedValue({ check: check(), cached: false });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls[0]?.[0] as string;
    expect(text).toContain("Doesn't hold: The manual lists E-19");
    expect(text).toContain('Corrected claim: Error code E-19');
    expect(text).toContain('- The manual lists E-19 for a blocked impeller. (Source: Pump manual, p. 2)');
    expect(text.split('\n').at(-1)).toBe('The advice to look for E-17 would change to E-19.');
  });

  it('is reached and closed from the keyboard: focus goes in, Escape closes it', async () => {
    post.mockResolvedValue({ check: check(), cached: false });
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    onTestFinished(() => before.remove());
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    const card = await screen.findByRole('dialog', { name: 'Fact-check' });
    await waitFor(() => expect(card).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(useSelectionCheck.getState().card).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(before).toHaveFocus();
  });

  it('says a check was made before, with a way to check again', async () => {
    post.mockResolvedValue({ check: check(), cached: true });
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    expect(await screen.findByText(/You checked this before/)).toBeInTheDocument();
    post.mockResolvedValue({ check: check({ id: 'sck_2' }), cached: false });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/messages/m_1/selection-checks', {
        text: 'Error code E-17 means the impeller is blocked.',
        again: true,
      }),
    );
  });

  it('offers the web for one check when it was not used, and says why when it may not be', async () => {
    post.mockResolvedValue({
      check: check({ web: { used: false, note: null }, evidence: check().evidence.slice(0, 1) }),
      cached: false,
    });
    useSelectionCheck.getState().openCard(highlight);
    const { unmount } = render(<FactcheckCard messageId="m_1" />);
    expect(await screen.findByText(/Checked against your sources only/)).toBeInTheDocument();
    post.mockResolvedValue({ check: check({ id: 'sck_web' }), cached: false });
    fireEvent.click(screen.getByRole('button', { name: 'Check again with the web' }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/messages/m_1/selection-checks', {
        text: 'Error code E-17 means the impeller is blocked.',
        web: true,
        again: true,
      }),
    );
    unmount();

    useSelectionCheck.setState({ card: null });
    const note = 'This notebook keeps everything on this machine, so nothing was looked up on the web.';
    post.mockResolvedValue({ check: check({ web: { used: false, note } }), cached: false });
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again with the web' })).toBeNull();
  });

  it('says plainly that no second opinion is available, with the way to fix it (GR24)', async () => {
    post.mockRejectedValue(
      new ApiCallError(422, {
        error: {
          ...localError(
            'factcheck.no_other_family',
            'No second opinion is available',
            'This was written by a claude model, and a fact-check is always judged by a model from a different family.',
            'e'.repeat(32),
          ).error,
          retryable: false,
        },
      }),
    );
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No second opinion is available');
    expect(screen.getByText(/a different family/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Models' }));
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({ to: '/admin/$section', params: { section: 'models' } }),
    );
  });

  it('shows what ran when code was run, and that it did not when it was not', async () => {
    post.mockResolvedValue({
      check: check({ kind: 'code', text: 'print(2 + 2)', ran: { ran: true, ok: true, output: '4' } }),
      cached: false,
    });
    useSelectionCheck.getState().openCard({ ...highlight, text: 'print(2 + 2)' });
    const { unmount } = render(<FactcheckCard messageId="m_1" />);
    expect(await screen.findByText('Ran in the sandbox: 4')).toBeInTheDocument();
    unmount();
    useSelectionCheck.setState({ card: null });
    post.mockResolvedValue({
      check: check({ kind: 'code', ran: { ran: false, ok: false, output: 'Not run: only Python is run.' } }),
      cached: false,
    });
    useSelectionCheck.getState().openCard(highlight);
    render(<FactcheckCard messageId="m_1" />);
    expect(await screen.findByText('Not run: only Python is run.')).toBeInTheDocument();
  });

  it('is placed under the highlight, over it when there is no room, and as a sheet on a phone', () => {
    const size = { w: 420, h: 300 };
    const view = { w: 1000, h: 700 };
    expect(placeCard({ left: 100, top: 100, right: 200, bottom: 120 }, size, view).top).toBe(130);
    expect(placeCard({ left: 100, top: 500, right: 200, bottom: 520 }, size, view).top).toBe(190);
    expect(placeCard({ left: 900, top: 100, right: 990, bottom: 120 }, size, view).left).toBe(570);
  });
});

describe('the composer', () => {
  it('adds the follow-up to what is already written, and sends nothing', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    get.mockResolvedValue([]);
    vi.mocked(api.put).mockResolvedValue({});
    post.mockResolvedValue({});
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <Composer threadId="thr_1" parentId="m1" onSend={onSend} notebookId={null} />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Also, a question.' } });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ancile:composer-insert', {
          detail: { threadId: 'thr_1', text: 'Start from this.' },
        }),
      );
      // Another thread's composer is left alone.
      window.dispatchEvent(
        new CustomEvent('ancile:composer-insert', { detail: { threadId: 'thr_2', text: 'Not here.' } }),
      );
    });
    expect(input.value).toBe('Also, a question.\n\nStart from this.');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('the Evidence tab', () => {
  const thread = (extra: Partial<ThreadView['messages'][number]> = {}): ThreadView => ({
    id: 't_1',
    title: 'A thread',
    notebookId: 'nb_1',
    messages: [
      {
        id: 'm_1',
        parentId: null,
        role: 'assistant',
        blocks: [],
        parts: [{ type: 'text', text: 'An answer.' }],
        modelId: null,
        createdAt: new Date().toISOString(),
        provenance: { selection_checks: [check()] },
        ...extra,
      },
    ],
  });

  function evidence(t: ThreadView) {
    params.threadId = 't_1';
    queryClient.setQueryData(keys.thread('t_1'), t);
    return render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <EvidencePanel />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
  }

  it('lists the highlighted claims that were checked, so they survive a reload', async () => {
    get.mockResolvedValue(null);
    evidence(thread());
    const section = await screen.findByRole('region', { name: 'Highlighted claims' });
    expect(within(section).getByText("Doesn't hold")).toBeInTheDocument();
    expect(within(section).getByText('Error code E-19 means the impeller is blocked.')).toBeInTheDocument();
    expect(within(section).getByText(/Checked by .* · \$0\.0021/)).toBeInTheDocument();
  });

  it('marks the row a card sent you to', async () => {
    get.mockResolvedValue(null);
    useUi.setState({ focusedCheck: 'sck_1' });
    evidence(thread());
    const section = await screen.findByRole('region', { name: 'Highlighted claims' });
    expect(section.querySelector('[data-check="sck_1"]')).toHaveAttribute('data-focused', 'true');
  });
});

describe('EV1: the Evidence tab while a check runs', () => {
  const answer: ThreadView = {
    id: 't_1',
    title: 'A thread',
    notebookId: 'nb_1',
    messages: [
      {
        id: 'm_1',
        parentId: null,
        role: 'assistant',
        blocks: [],
        parts: [{ type: 'text', text: 'An answer.' }],
        modelId: null,
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const panel = () => {
    params.threadId = 't_1';
    queryClient.setQueryData(keys.thread('t_1'), answer);
    return render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <EvidencePanel />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
  };

  it('shows each claim as it is found and its verdict as it lands, not a skeleton', async () => {
    get.mockResolvedValue(null);
    useFactcheckProgress.setState({
      byMessage: { m_1: { stage: 'verifying', done: 1, total: 3 } },
      claims: {
        m_1: [
          {
            index: 0,
            text: 'The pump must be primed.',
            checkable: true,
            verdict: 'verified',
            rationale: 'E1 says so.',
            judge: 'google/gemini-pro',
            quotes: [
              {
                source_title: 'Pump manual',
                quote: 'Prime the pump first.',
                stance: 'supports',
                origin: 'source',
              },
            ],
          },
          { index: 1, text: 'Error code E-17 is the impeller.', checkable: true },
          { index: 2, text: 'I think it is fine.', checkable: false, verdict: 'not_checkable' },
        ],
      },
    });
    panel();
    const list = await screen.findByRole('list', { name: 'Claims found so far' });
    const cards = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('claim-card'));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute('data-live', 'judged');
    expect(within(cards[0] as HTMLElement).getByText('Judged by Gemini Pro')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText('Prime the pump first.')).toBeInTheDocument();
    expect(cards[1]).toHaveAttribute('data-live', 'found');
    expect(within(cards[1] as HTMLElement).getByText('Checking')).toBeInTheDocument();
    expect(screen.queryByLabelText('Checking claims')).toBeNull();
  });

  it('says what stage it is at before the first claim is found', async () => {
    get.mockResolvedValue(null);
    useFactcheckProgress.setState({
      byMessage: { m_1: { stage: 'extracting', done: 0, total: 0 } },
      claims: {},
    });
    panel();
    expect(await screen.findByText('Finding the claims in this answer')).toBeInTheDocument();
  });

  it('names a Claude Code judge as running on the Claude plan (FC2)', async () => {
    get.mockResolvedValue(null);
    useFactcheckProgress.setState({
      byMessage: { m_1: { stage: 'verifying', done: 1, total: 1 } },
      claims: {
        m_1: [
          {
            index: 0,
            text: 'A claim of some length.',
            checkable: true,
            verdict: 'verified',
            judge: 'claude-code/haiku',
          },
        ],
      },
    });
    panel();
    expect(await screen.findByText(/Judged by .*, on your Claude plan/)).toBeInTheDocument();
  });

  it('keeps the claims by the order they were found, and a verdict keeps the words it was found with', () => {
    const s = useFactcheckProgress.getState();
    s.claim('m_9', { index: 1, text: 'Second', checkable: true });
    s.claim('m_9', { index: 0, text: 'First', checkable: true });
    s.claim('m_9', { index: 1, text: 'Second', checkable: true, verdict: 'contradicted' });
    expect(useFactcheckProgress.getState().claims.m_9?.map((c) => [c.index, c.verdict])).toEqual([
      [0, undefined],
      [1, 'contradicted'],
    ]);
    s.set('m_9', null);
    expect(useFactcheckProgress.getState().claims.m_9).toBeUndefined();
  });
});

describe('EV2: what retrieval found', () => {
  const turn = (): LiveTurn =>
    ({
      runId: 'run_1',
      threadId: 't_1',
      messageId: 'm_1',
      parts: [],
      status: 'running',
      modelId: null,
      modelName: null,
      fallback: null,
      waking: null,
      approvalId: null,
      approvals: {},
      error: null,
      done: false,
      lastSeq: 0,
      startedAt: null,
      calls: {},
      streamedChars: 0,
      reportedTokens: null,
      activity: null,
    }) as LiveTurn;

  const event = (over: Record<string, unknown>) =>
    ({
      type: 'retrieval.done',
      seq: 3,
      at: '2026-10-19T03:00:00.000Z',
      chunks: 3,
      sources: 2,
      ms: 41,
      query: 'how do I prime the pump',
      searched: 'notebook',
      found: [
        { source_title: 'Pump manual', page: 2, score: 0.91 },
        { source_title: 'Pump manual', page: 5, score: 0.74 },
        { source_title: 'Notes', page: null, score: 0.62 },
      ],
      ...over,
    }) as never;

  it('carries the query and each passage into the live turn', () => {
    const t = fold(turn(), event({}));
    expect(t.retrieval).toMatchObject({ query: 'how do I prime the pump', chunks: 3, sources: 2 });
    expect(t.retrieval?.found).toHaveLength(3);
  });

  it('reads "Searched 2 sources", and opens to the query and each source with its score', () => {
    const r = fold(turn(), event({})).retrieval;
    if (!r) throw new Error('no retrieval');
    render(<SearchedLine r={r} />);
    expect(screen.getByText('Searched 2 sources')).toBeInTheDocument();
    expect(screen.getByText('“how do I prime the pump”')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Pump manual, p. 20.91',
      'Pump manual, p. 50.74',
      'Notes0.62',
    ]);
  });

  it('says so when nothing matched, when only mentioned sources were searched, and for linked notebooks', () => {
    expect(searchedLabel({ chunks: 0, sources: 0, searched: 'notebook' })).toBe(
      'Searched your sources: nothing matched',
    );
    expect(searchedLabel({ chunks: 0, sources: 0, searched: 'mentioned' })).toBe(
      'Searched the sources you mentioned: nothing matched',
    );
    expect(searchedLabel({ chunks: 2, sources: 1, searched: 'mentioned' })).toBe(
      'Searched 1 source you mentioned',
    );
    expect(searchedLabel({ chunks: 4, sources: 3, searched: 'links' })).toBe(
      'Searched 3 sources, linked notebooks too',
    );
    const r = fold(turn(), event({ chunks: 0, sources: 0, found: [], query: '' })).retrieval;
    if (!r) throw new Error('no retrieval');
    render(<SearchedLine r={r} />);
    expect(screen.getByText('Searched your sources: nothing matched')).toBeInTheDocument();
  });

  it('is a step in the receipt: the query, the sources and their scores', () => {
    const search = searchFactsOf({
      query: 'how do I prime the pump',
      hits: [
        { source_id: 'a', source_title: 'Pump manual', page: 2, score: 0.91 },
        { source_id: 'a', source_title: 'Pump manual', page: 5, score: 0.74 },
        { source_id: 'b', source_title: 'Notes', page: null, score: 0.62 },
      ],
    });
    const steps = buildSteps({ calls: [], parts: [], recovered: [], priced: false, search });
    expect(steps[0]).toMatchObject({
      kind: 'context',
      label: 'Searched 2 sources',
      detail: '“how do I prime the pump” · Pump manual, p. 2 (0.91), Pump manual, p. 5 (0.74), Notes (0.62)',
    });
    expect(searchDetail({ query: '', found: [] })).toBeNull();
    expect(buildSteps({ calls: [], parts: [], recovered: [], priced: false, search: null })).toEqual([]);
  });
});
