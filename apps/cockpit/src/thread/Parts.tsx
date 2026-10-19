/**
 * ------------------------------------------------------------------
 *  Title    |  Message parts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Draw a message the way Core stores it: prose as
 *           |  markdown, tool calls as steps you can read at a glance
 *           |  (what, on what, and how it went), thinking folded away,
 *           |  and a quiet seam where one model took over from another.
 *  How      |  Streamdown renders the prose. It is built for text that
 *           |  is still arriving (an unclosed code fence or bold does
 *           |  not break the layout mid-stream) and sanitises HTML.
 *           |  Its own controls are off; Aperture styles the output.
 * ------------------------------------------------------------------
 */

import type { FactcheckClaim, Part } from '@nvx/contracts';
import { keptWords } from '@nvx/contracts/attachments';
import { ProseWithArtifacts } from '../artifacts/ArtifactCard';
import { ImageThreadProvider, ThreadImage } from '../images/ThreadImage';
import { modelName } from '../lib/format';
import { useRuns } from '../lib/run';
import type { SubagentView } from '../lib/types';
import { usePrefs } from '../state/prefs';
import { Icon } from '../ui/Icon';
import { linkMarkers, MD_COMPONENTS } from './Citations';
import { markClaims } from './Claims';
import { ToolStep } from './ToolStepLazy';
import {
  GROUP_AFTER,
  Prose,
  SubagentConversation,
  type ToolCall,
  ToolGroup,
  type ToolResult,
} from './ToolSteps';

export { RESULT_LINES, ResultText, SubagentConversation } from './ToolSteps';

type Segment =
  | { kind: 'text'; key: string; text: string; base: number }
  | { kind: 'reasoning'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ToolCall; result: ToolResult | undefined }
  | { kind: 'seam'; key: string; from: string; to: string }
  | {
      kind: 'file';
      key: string;
      name: string;
      pages: number | undefined;
      truncated: boolean;
      kept: string | null;
    }
  | {
      kind: 'image';
      key: string;
      src: string;
      alt: string;
      width: number | undefined;
      height: number | undefined;
    };

function segments(parts: Part[]): Segment[] {
  const results = new Map(parts.flatMap((p) => (p.type === 'tool_result' ? [[p.call_id, p] as const] : [])));
  const out: Segment[] = [];
  // Where each text part starts in the answer's text (its text parts joined), for claim offsets.
  let base = 0;
  parts.forEach((p, i) => {
    if (p.type === 'text') {
      // Whitespace between two tool calls (a blank line) is not prose: it would split a run
      // of steps and leave a blank gap where it was drawn.
      if (p.text.trim()) out.push({ kind: 'text', key: `t${i}`, text: p.text, base });
      base += p.text.length;
    }
    if (p.type === 'reasoning' && p.text.trim()) out.push({ kind: 'reasoning', key: `r${i}`, text: p.text });
    else if (p.type === 'tool_call')
      out.push({ kind: 'tool', key: p.call_id, call: p, result: results.get(p.call_id) });
    else if (p.type === 'seam') out.push({ kind: 'seam', key: `s${i}`, from: p.from_model, to: p.to_model });
    else if (p.type === 'file' && p.text !== undefined)
      out.push({
        kind: 'file',
        key: `f${i}`,
        name: p.name,
        pages: p.pages,
        truncated: !!p.truncated,
        // CH6 (Pro): only the relevant pages went; the words come from the file's own record.
        kept: p.kept ? keptWords(p.kept) : null,
      });
    else if (p.type === 'image')
      out.push({
        kind: 'image',
        key: `i${i}`,
        src: p.url,
        alt: p.alt ?? p.caption ?? '',
        width: p.width,
        height: p.height,
      });
  });
  return out;
}

type Item = { kind: 'one'; seg: Segment; index: number } | { kind: 'group'; key: string; segs: Segment[] };

/**
 * Runs of tool steps (with the thinking between them) longer than
 * GROUP_AFTER fold into one group, so a long agentic turn reads as one line.
 * Thinking after the last step of a run stays outside it.
 */
export function groupSegments(segs: Segment[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i] as Segment;
    if (seg.kind !== 'tool') {
      out.push({ kind: 'one', seg, index: i });
      i++;
      continue;
    }
    let j = i;
    let lastTool = i;
    while (j < segs.length && (segs[j]?.kind === 'tool' || segs[j]?.kind === 'reasoning')) {
      if (segs[j]?.kind === 'tool') lastTool = j;
      j++;
    }
    const run = segs.slice(i, lastTool + 1);
    const tools = run.filter((x) => x.kind === 'tool').length;
    if (tools > GROUP_AFTER) out.push({ kind: 'group', key: `g-${seg.key}`, segs: run });
    else for (const [k, x] of run.entries()) out.push({ kind: 'one', seg: x, index: i + k });
    i = lastTool + 1;
  }
  return out;
}

/** Thinking, folded to one quiet line until asked for. */
export function Thinking({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="thinking">
      <summary>
        <Icon name="chevronRight" size={11} className="thinking__chev" />
        {live ? 'Thinking' : 'Thought for a while'}
      </summary>
      <div className="thinking__body">
        <Prose text={text} />
      </div>
    </details>
  );
}

export function Parts({
  parts,
  streaming,
  waiting,
  claims,
  holdText = false,
  subagents,
  messageId = null,
  threadId = null,
  approvals,
}: {
  /** Approvals still open, by tool call: each waiting step opens its own. */
  approvals?: Record<string, string> | undefined;
  threadId?: string | null;
  /** The answer these parts belong to: artifacts in it are versioned by it. */
  messageId?: string | null;
  /** Claude Code subagent transcripts: under their tool step, or at the end. */
  subagents?: SubagentView[] | undefined;
  parts: Part[];
  streaming: boolean;
  waiting: boolean;
  /** Settings → Reading → "When finished": keep the prose back until the answer is whole. */
  holdText?: boolean;
  /** Fact-checked claims to underline, at offsets into the answer's text. */
  claims?: FactcheckClaim[] | undefined;
}) {
  const folded = usePrefs((s) => s.prefs.reading.collapseTools);
  // While the answer is written, each step's start and end, for its timer.
  const clocks = useRuns((s) => (messageId ? s.turns[messageId]?.calls : undefined));
  const segs = segments(parts);
  const lastText = segs.findLastIndex((s) => s.kind === 'text');
  const calls = new Set(segs.flatMap((s) => (s.kind === 'tool' ? [s.call.call_id] : [])));
  const loose = (subagents ?? []).filter((a) => !a.callId || !calls.has(a.callId));
  // A step waits when its own call has an open approval; without that map, any open one.
  const known = !!approvals && Object.keys(approvals).length > 0;
  const stepWaits = (callId: string) => waiting && (!known || !!approvals?.[callId]);

  const one = (s: Segment, i: number) => {
    switch (s.kind) {
      case 'text':
        if (holdText) return null;
        return (
          <ProseWithArtifacts
            key={s.key}
            messageId={messageId}
            threadId={threadId}
            live={streaming}
            className="md"
            mode={streaming && i === lastText ? 'streaming' : 'static'}
            isAnimating={streaming && i === lastText}
            parseIncompleteMarkdown={streaming && i === lastText}
            controls={false}
            components={MD_COMPONENTS}
            plugins="thread"
          >
            {linkMarkers(streaming ? s.text : markClaims(s.text, s.base, claims))}
          </ProseWithArtifacts>
        );
      case 'reasoning':
        return <Thinking key={s.key} text={s.text} live={streaming && i === segs.length - 1} />;
      case 'tool':
        return (
          <ToolStep
            key={s.key}
            call={s.call}
            result={s.result}
            waiting={stepWaits(s.call.call_id)}
            approvalId={approvals?.[s.call.call_id] ?? null}
            folded={folded}
            clock={clocks?.[s.call.call_id]}
            live={streaming}
            subagent={subagents?.find((a) => a.callId === s.call.call_id)}
          />
        );
      case 'image':
        return (
          <figure key={s.key} className="msg-image">
            <ThreadImage src={s.src} alt={s.alt} width={s.width} height={s.height} />
          </figure>
        );
      case 'file':
        return (
          <p key={s.key} className="msg-file">
            <Icon name="attach" size={12} />
            <span className="msg-file__name">{s.name}</span>
            {s.pages ? (
              <span className="mute" data-num>
                {s.pages} {s.pages === 1 ? 'page' : 'pages'}
              </span>
            ) : null}
            {s.truncated ? <span className="mute">start only</span> : null}
            {s.kept ? <span className="mute">{s.kept}</span> : null}
          </p>
        );
      case 'seam':
        return (
          <p key={s.key} className="seam" title="NVX Ancile switched models without starting over.">
            {modelName(s.to)} continued after {modelName(s.from)} stopped
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <ImageThreadProvider threadId={threadId}>
      {groupSegments(segs).map((item) => {
        if (item.kind === 'one') return one(item.seg, item.index);
        const steps = item.segs.flatMap((x) =>
          x.kind === 'tool' ? [{ call: x.call, result: x.result }] : [],
        );
        return (
          <ToolGroup key={item.key} steps={steps} open={waiting && steps.some((x) => !x.result)}>
            {item.segs.map((x) => one(x, -1))}
          </ToolGroup>
        );
      })}
      {loose.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: transcripts without a call have only their place
        <SubagentConversation key={`sub-${i}`} s={a} />
      ))}
    </ImageThreadProvider>
  );
}
