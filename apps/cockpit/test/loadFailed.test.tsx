/**
 * D4: a failed read always offers Try again, in the failure's own words;
 * an action's failure keeps the rule that Try again shows only when the
 * error says a retry can help. Core not answering, and an answer the
 * Cockpit could not read, get the Cockpit's own words in the same card.
 * A refresh that failed under data still on screen is one slim line.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiCallError, localError, OfflineError } from '../src/lib/api';
import { ErrorState } from '../src/ui/ErrorState';
import { LoadFailed, loadError, StaleNotice } from '../src/ui/LoadFailed';

/** Core's answer that a retry will not help (a 4xx, retryable false). */
const refused = (title = 'The notebook store is locked', hint = 'Close the other window, then try again.') =>
  new ApiCallError(423, {
    error: { ...localError('store.locked', title, hint, 'c'.repeat(32)).error, retryable: false },
  });

describe('ErrorState and its retry policy', () => {
  it("keeps an action's rule: no Try again when the error says a retry cannot help", () => {
    const onRetry = vi.fn();
    render(<ErrorState error={refused().body} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The notebook store is locked');
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.getByRole('button', { name: /copy debug info/i })).toBeInTheDocument();
  });

  it('offers Try again for any error when told a retry is always harmless (a read)', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={refused().body} onRetry={onRetry} retry="always" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to retry without an onRetry, whatever the policy', () => {
    render(<ErrorState error={refused().body} retry="always" />);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('stays busy while the retry runs, and ignores a second press', async () => {
    let finish: () => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ErrorState error={refused().body} onRetry={onRetry} retry="always" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const busy = screen.getByRole('button', { name: 'Trying again' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('data-busy');
    fireEvent.click(busy);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByRole('button', { name: 'Try again' })).not.toHaveAttribute('aria-disabled');
  });

  it('comes back from a retry that failed, ready to try once more', async () => {
    const onRetry = vi.fn(() => Promise.reject(new Error('still down')));
    render(<ErrorState error={refused().body} onRetry={onRetry} retry="always" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

describe('LoadFailed', () => {
  it("shows Core's own words with Try again, even for an error marked not retryable", () => {
    const onRetry = vi.fn();
    render(<LoadFailed error={refused()} what="Sources" onRetry={onRetry} />);
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('The notebook store is locked');
    expect(card).toHaveTextContent('Close the other window, then try again.');
    // The trace id Core gave, shortened.
    expect(card).toHaveTextContent('cccccccccccc');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says NVX Ancile is not answering when Core never answered, with no trace to name', () => {
    const { container } = render(
      <LoadFailed
        error={new OfflineError(new TypeError('fetch failed'))}
        what="Sources"
        onRetry={() => {}}
      />,
    );
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('Sources could not be loaded');
    expect(card).toHaveTextContent('NVX Ancile is not answering. Check that it is running, then try again.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(container.querySelector('.error-state__trace')).toBeNull();
    // A failure card, never an empty state.
    expect(container.querySelector('.empty')).toBeNull();
  });

  it('names an answer the Cockpit could not read without showing its insides', () => {
    render(
      <LoadFailed
        error={new SyntaxError('Unexpected token < in JSON')}
        what="The fleet"
        onRetry={() => {}}
      />,
    );
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('The fleet could not be loaded');
    expect(card).toHaveTextContent('If it keeps failing, copy the debug info and report it.');
    expect(card).not.toHaveTextContent('Unexpected token');
  });

  it('keeps the message for the debug info, and nothing for Core being away', () => {
    expect(loadError(new Error('boom'), 'Notes').error.context).toEqual({
      service: 'cockpit',
      message: 'boom',
    });
    expect(loadError(new OfflineError(null), 'Notes').error).toMatchObject({
      code: 'cockpit.offline',
      retryable: true,
      context: { service: 'cockpit' },
    });
    // Core's own error passes through untouched.
    const e = refused();
    expect(loadError(e, 'Notes')).toBe(e.body);
  });

  it('renders compact for narrow places', () => {
    const { container } = render(<LoadFailed compact error={refused()} what="Rules" onRetry={() => {}} />);
    expect(container.querySelector('.error-state')).toHaveAttribute('data-compact');
  });
});

describe('StaleNotice', () => {
  it("says the refresh failed, in Core's words, and keeps a Try again", () => {
    const onRetry = vi.fn();
    render(<StaleNotice error={refused('The store is locked.')} what="Sources" onRetry={onRetry} />);
    const line = screen.getByRole('status');
    // One full stop, not two.
    expect(line).toHaveTextContent(
      'Sources could not be loaded: The store is locked. What you see was loaded earlier.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves Core being down to the connection banner', () => {
    const { container } = render(
      <StaleNotice error={new OfflineError(null)} what="Sources" onRetry={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing without an error, and its own note when given one', () => {
    const { container, rerender } = render(<StaleNotice error={null} what="Sources" onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <StaleNotice
        error={new Error('x')}
        what="Its versions"
        note="This is the copy in the answer."
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Its versions could not be loaded. This is the copy in the answer.',
    );
  });
});
