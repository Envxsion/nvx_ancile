/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact card and prose with artifacts
 *  Ref      |  docs/artifacts.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  In an answer, an artifact reads as one quiet card (what
 *           |  it is, its title, its version) that opens the panel,
 *           |  instead of a wall of markup. While the answer is still
 *           |  writing it, the card says so and counts the lines.
 *  How      |  ProseWithArtifacts splits the text around artifacts
 *           |  (splitArtifacts, shared with Core) and renders each
 *           |  text piece with the same Streamdown the answer uses, so
 *           |  an answer with no artifact renders exactly as before.
 *           |  When an artifact finishes while you watch, the panel
 *           |  opens on it once.
 * ------------------------------------------------------------------
 */

import { fade } from '@nvx/aperture';
import { type ParsedArtifact, splitArtifacts } from '@nvx/contracts';
import { m as motion } from 'motion/react';
import { useEffect, useMemo, useRef } from 'react';
import { useReducedMotion } from '../lib/motion';
import { Icon } from '../ui/Icon';
import { Markdown, type MarkdownProps } from '../ui/Markdown';
import { lineCount, TYPE_ICON, TYPE_LABEL } from './meta';
import { openArtifact, useArtifacts, useThreadArtifacts } from './store';

export function ArtifactCard({
  artifact,
  messageId,
  threadId,
  live,
}: {
  artifact: ParsedArtifact;
  messageId: string | null;
  threadId: string | null;
  /** The answer is still streaming. */
  live: boolean;
}) {
  const list = useThreadArtifacts(artifact.complete && !live ? threadId : null);
  const open = useArtifacts((s) => s.open);
  const reduce = useReducedMotion();
  const record = list.data?.items.find((a) => a.key === artifact.key);
  const version = record?.versions.find((v) => v.message_id === messageId)?.version;
  const isOpen = open?.artifact.key === artifact.key && open.messageId === messageId;
  const writing = !artifact.complete;

  // Finished while you watched: open it once, unless something else is open.
  const wasWriting = useRef(writing && live);
  useEffect(() => {
    if (wasWriting.current && !writing) {
      wasWriting.current = false;
      if (!useArtifacts.getState().open) openArtifact({ threadId, messageId, artifact });
    }
  }, [writing, threadId, messageId, artifact]);

  const show = () => openArtifact({ threadId, messageId, artifact });
  return (
    <motion.button
      type="button"
      className="artifact-card"
      data-writing={writing || undefined}
      data-open={isOpen || undefined}
      onClick={show}
      disabled={writing}
      // Reduced motion keeps the fade (shorter) and drops the rise.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? fade : { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      aria-label={
        writing ? `Writing ${artifact.title}` : `Open ${artifact.title}, ${TYPE_LABEL[artifact.type]}`
      }
    >
      <span className="artifact-card__tile" aria-hidden="true">
        <Icon name={TYPE_ICON[artifact.type]} size={16} />
      </span>
      <span className="artifact-card__text">
        <span className="artifact-card__title" dir="auto">
          {artifact.title}
        </span>
        <span className="artifact-card__meta">
          {writing
            ? `Writing · ${lineCount(artifact.content).toLocaleString('en-GB')} lines`
            : `${TYPE_LABEL[artifact.type]}${artifact.language && artifact.type === 'code' ? ` · ${artifact.language}` : ''}${
                version && record && record.versions.length > 1
                  ? ` · version ${version} of ${record.versions.length}`
                  : ''
              }`}
        </span>
      </span>
      <span className="artifact-card__go" aria-hidden="true">
        {writing ? <span className="artifact-card__pulse" /> : <Icon name="expand" size={13} />}
      </span>
    </motion.button>
  );
}

type StreamdownProps = MarkdownProps;

/**
 * Streamdown for an answer's text, with each artifact as a card. Takes
 * Streamdown's own props; `children` is the text.
 */
export function ProseWithArtifacts({
  children,
  messageId,
  threadId = null,
  live,
  ...props
}: Omit<StreamdownProps, 'children'> & {
  children: string;
  messageId: string | null;
  threadId?: string | null;
  live: boolean;
}) {
  const pieces = useMemo(() => splitArtifacts(children), [children]);
  if (pieces.length === 1 && pieces[0]?.kind === 'text') return <Markdown {...props}>{children}</Markdown>;
  const lastText = pieces.findLastIndex((p) => p.kind === 'text');
  return (
    <>
      {pieces.map((p, i) =>
        p.kind === 'text' ? (
          p.text.trim() ? (
            <Markdown
              key={`after-${pieces[i - 1]?.kind === 'artifact' ? (pieces[i - 1] as { artifact: ParsedArtifact }).artifact.key : 'start'}`}
              {...props}
              {...(i !== lastText && { isAnimating: false, mode: 'static' })}
            >
              {p.text}
            </Markdown>
          ) : null
        ) : (
          <ArtifactCard
            key={`a${p.artifact.key}`}
            artifact={p.artifact}
            messageId={messageId}
            threadId={threadId}
            live={live}
          />
        ),
      )}
    </>
  );
}
