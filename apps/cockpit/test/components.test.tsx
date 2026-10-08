import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmationChain } from '../src/compute/ConfirmationChain';
import { localError } from '../src/lib/api';
import { ErrorState } from '../src/ui/ErrorState';

describe('ErrorState', () => {
  it('shows what happened and what to do, never a stack', () => {
    render(
      <ErrorState
        error={localError(
          'provider.auth_failed',
          'Anthropic rejected the API key',
          'Update the key in Settings.',
          'a'.repeat(32),
        )}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Anthropic rejected the API key');
    expect(screen.getByText('Update the key in Settings.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy debug info/i })).toBeInTheDocument();
  });

  it('offers retry when the error is retryable', () => {
    let retried = false;
    render(
      <ErrorState
        error={localError('x', 'Timed out', 'Try again.', 'b'.repeat(32))}
        onRetry={() => {
          retried = true;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retried).toBe(true);
  });
});

describe('ConfirmationChain', () => {
  it('marks the failing link and shows the suggested fix', () => {
    render(
      <ConfirmationChain
        title="Start research-h100"
        reached={1}
        failed
        timeline={['17:20:05', '17:20:06']}
        detail="No instances available."
        suggestion="Try EU-SE-1."
      />,
    );
    const links = screen.getAllByRole('listitem');
    expect(links[0]).toHaveAttribute('data-state', 'done');
    expect(links[1]).toHaveAttribute('data-state', 'done');
    expect(links[2]).toHaveAttribute('data-state', 'failed');
    expect(screen.getByText('Try EU-SE-1.')).toBeInTheDocument();
  });

  it('marks the current link while working', () => {
    render(<ConfirmationChain title="Restart" reached={2} timeline={[]} detail="Pulling weights" />);
    expect(screen.getAllByRole('listitem')[2]).toHaveAttribute('aria-current', 'step');
  });
});
