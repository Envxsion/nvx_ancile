/**
 * ------------------------------------------------------------------
 *  Title    |  Apply to repo: where it opens
 *  Ref      |  roadmap AN3 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A code block in an answer gets "Apply to repo" when
 *           |  its thread has a linked repository. With Pro and the
 *           |  licence, Pro's own dialog (ProUi.parts.ApplyToRepo)
 *           |  turns the block into a proposed patch and shows the
 *           |  diff; without them the dialog says what it is and what
 *           |  unlocks it.
 *  How      |  The button is shown only in an answer, in a thread with
 *           |  a linked repo (no repo: no button). It is disabled while
 *           |  the answer is still being written, because the fence may
 *           |  not be finished. This file draws the dialog and hands
 *           |  Pro the block, the repo and when the answer was
 *           |  written. Nothing is read or written here: Pro reads and
 *           |  writes through GET and PUT /files, so permissions/decide
 *           |  sees the real path.
 *  Note     |  Code from an answer is data and is never run.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { useAnswer, useThreadId } from '../lib/threadContext';
import { useLinkedRepo, useRepoScope } from '../repos/data';
import '../styles/apply.css';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import { useProFeature } from './slot';

export function ApplyToRepo({ code, lang }: { code: string; lang: string | null | undefined }) {
  const threadId = useThreadId();
  const answer = useAnswer();
  const scope = useRepoScope();
  const repo = useLinkedRepo(scope);
  const [open, setOpen] = useState(false);
  // No thread, no answer or no linked repository: there is nowhere to apply it, so no button.
  if (!threadId || !answer || !repo.data) return null;
  const waiting = answer.streaming;
  return (
    <>
      <button
        type="button"
        className="code__act"
        disabled={waiting}
        aria-haspopup="dialog"
        title={
          waiting
            ? 'Wait for the answer to finish: the code block may not be complete yet'
            : `Turn this into a patch for ${repo.data.name} and review it before anything is written`
        }
        onClick={() => setOpen(true)}
      >
        <Icon name="seal" size={12} className="gilt-ink" />
        <span className="code__copy-word">Apply to repo</span>
      </button>
      {open ? (
        <ApplyDialog
          threadId={threadId}
          code={code}
          lang={lang ?? null}
          repo={{ id: repo.data.id, name: repo.data.name, root: repo.data.root }}
          answeredAt={answer.createdAt}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ApplyDialog({
  threadId,
  code,
  lang,
  repo,
  answeredAt,
  onClose,
}: {
  threadId: string;
  code: string;
  lang: string | null;
  repo: { id: string; name: string; root: string };
  answeredAt: string;
  onClose: () => void;
}) {
  useLayer(true);
  const { ui, unlocked, build, loading, noSeat } = useProFeature('code_apply');
  const Part = ui?.parts?.ApplyToRepo;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="apply" aria-describedby={undefined}>
          <header className="apply__head">
            <Dialog.Title className="apply__title">
              <Icon name="seal" size={14} className="gilt-ink" /> Apply to {repo.name}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn icon-btn--sm" aria-label="Close">
                <Icon name="close" size={13} />
              </button>
            </Dialog.Close>
          </header>
          <div className="apply__body">
            {loading ? (
              <Skeleton lines={4} label="Loading" />
            ) : Part && unlocked ? (
              <Part
                threadId={threadId}
                code={code}
                lang={lang}
                repo={repo}
                answeredAt={answeredAt}
                onClose={onClose}
              />
            ) : (
              <div className="pro-card gilt-frame gilt-frame--quiet">
                <EmptyState
                  icon="seal"
                  title="Apply a code block to your repository"
                  body={
                    <>
                      Turn the code in an answer into a patch for {repo.name}, review it as a diff, and write
                      it only when you approve.{' '}
                      {noSeat
                        ? "Pro is on in this workspace, but your account has no Pro seat. Ask the workspace's owner for one."
                        : build === 'pro'
                          ? 'It is part of NVX Ancile Pro: turn Pro on with your key to use it.'
                          : 'It is part of NVX Ancile Pro, which this build does not include. Copy and Save as file work as they always have.'}
                    </>
                  }
                  secondary={
                    <Link
                      to="/admin/$section"
                      params={{ section: noSeat ? 'team' : 'license' }}
                      className="btn btn--ghost btn--sm"
                      onClick={onClose}
                    >
                      {noSeat ? 'See who has a seat' : build === 'pro' ? 'Turn on Pro' : 'About Pro'}
                    </Link>
                  }
                />
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
