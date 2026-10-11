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
import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { modelName } from '../lib/format';
import { shortResource } from '../lib/mappers';
import type { SubagentView } from '../lib/types';
import { usePrefs } from '../state/prefs';
import { Icon } from '../ui/Icon';
import { linkMarkers, MD_COMPONENTS } from './Citations';
import { markClaims } from './Claims';

type ToolCall = Extract<Part, { type: 'tool_call' }>;
type ToolResult = Extract<Part, { type: 'tool_result' }>;

type Segment =
  | { kind: 'text'; key: string; text: string; base: number }
  | { kind: 'reasoning'; key: string; text: string }
  | { kind: 'tool'; key: string; call: ToolCall; result: ToolResult | undefined }
  | { kind: 'seam'; key: string; from: string; to: string };

function segments(parts: Part[]): Segment[] {
  const results = new Map(parts.flatMap((p) => (p.type === 'tool_result' ? [[p.call_id, p] as const] : [])));
  const out: Segment[] = [];
  // Where each text part starts in the answer's text (its text parts joined), for claim offsets.
  let base = 0;
  parts.forEach((p, i) => {
    if (p.type === 'text') {
      if (p.text) out.push({ kind: 'text', key: `t${i}`, text: p.text, base });
      base += p.text.length;
    }
    if (p.type === 'reasoning' && p.text.trim()) out.push({ kind: 'reasoning', key: `r${i}`, text: p.text });
    else if (p.type === 'tool_call')
      out.push({ kind: 'tool', key: p.call_id, call: p, result: results.get(p.call_id) });
    else if (p.type === 'seam') out.push({ kind: 'seam', key: `s${i}`, from: p.from_model, to: p.to_model });
  });
  return out;
}

/** past, progressive, bare: "Wrote", "Writing", "write" */
const TOOL_VERBS: Record<string, [string, string, string]> = {
  fs_read: ['Read', 'Reading', 'read'],
  fs_list: ['Listed', 'Listing', 'list'],
  fs_write: ['Wrote', 'Writing', 'write'],
  fs_delete: ['Deleted', 'Deleting', 'delete'],
  // The lab's engine
  read: ['Read', 'Reading', 'read'],
  write: ['Wrote', 'Writing', 'write'],
  edit: ['Edited', 'Editing', 'edit'],
  apply_patch: ['Patched', 'Patching', 'patch'],
  list: ['Listed', 'Listing', 'list'],
  glob: ['Searched for', 'Searching for', 'search for'],
  grep: ['Searched for', 'Searching for', 'search for'],
  bash: ['Ran', 'Running', 'run'],
  webfetch: ['Fetched', 'Fetching', 'fetch'],
};

function target(args: unknown): string | null {
  const a = args as {
    path?: unknown;
    filePath?: unknown;
    url?: unknown;
    command?: unknown;
    pattern?: unknown;
  } | null;
  const file = a?.path ?? a?.filePath;
  const v = file ?? a?.url ?? a?.command ?? a?.pattern;
  if (typeof v !== 'string') return null;
  if (file === undefined) return v;
  // The lab reports real paths; show them relative to its folder.
  const p = v.replaceAll('\\', '/').replace(/^.*\/labs\/[^/]+\//, '');
  return shortResource(p.startsWith('/') ? `fs:${p}` : `fs:/workspace/${p}`);
}

type StepState = 'running' | 'waiting' | 'ok' | 'failed' | 'declined';

function stepLabel(tool: string, on: string | null, state: StepState): string {
  const v = TOOL_VERBS[tool];
  if (!v) return on ? `${tool} on ${on}` : tool;
  const what = on ?? 'the workspace';
  if (state === 'ok') return `${v[0]} ${what}`;
  if (state === 'declined') return `Didn't ${v[2]} ${what}`;
  if (state === 'failed') return `Couldn't ${v[2]} ${what}`;
  return `${v[1]} ${what}`;
}

function ToolStep({
  call,
  result,
  waiting,
  folded,
  subagent,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  waiting: boolean;
  subagent?: SubagentView | undefined;
  /** Settings → Reading: tool steps start as one line. */
  folded: boolean;
}) {
  const state: StepState = !result
    ? waiting
      ? 'waiting'
      : 'running'
    : result.declined_reason !== undefined
      ? 'declined'
      : result.ok
        ? 'ok'
        : 'failed';
  const detail =
    state === 'waiting'
      ? 'Waiting for your decision'
      : state === 'declined'
        ? result?.declined_reason || null
        : state === 'failed'
          ? String(result?.result ?? '')
          : null;
  const icon =
    state === 'ok' ? 'check' : state === 'waiting' ? 'shield' : state === 'running' ? 'model' : 'warn';
  return (
    <details className="tool-step" data-state={state} open={!folded || undefined}>
      <summary>
        <Icon name={icon} size={13} />
        <span className="tool-step__label">{stepLabel(call.tool, target(call.args), state)}</span>
        {detail ? <span className="tool-step__detail">{detail}</span> : null}
      </summary>
      <div className="tool-step__body">
        <div className="tool-step__k">Input</div>
        <pre data-num>{JSON.stringify(call.args, null, 2)}</pre>
        {result ? (
          <>
            <div className="tool-step__k">{result.ok ? 'Result' : 'What happened'}</div>
            <ResultText
              text={
                typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)
              }
            />
          </>
        ) : null}
        {subagent ? <SubagentConversation s={subagent} /> : null}
      </div>
    </details>
  );
}

/** Long results (a whole file, a long log) start short, with the rest one click away. */
export const RESULT_LINES = 24;
const RESULT_CHARS = 2400;

export function ResultText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > RESULT_LINES || text.length > RESULT_CHARS;
  if (!long || all) return <pre data-num>{text}</pre>;
  const head = lines.slice(0, RESULT_LINES).join('\n').slice(0, RESULT_CHARS);
  return (
    <>
      <pre data-num data-clipped>
        {head}
      </pre>
      <button type="button" className="link-btn tool-step__more" onClick={() => setAll(true)}>
        Show all {lines.length} lines
      </button>
    </>
  );
}

/** A Claude Code subagent's own conversation, folded away. */
export function SubagentConversation({ s }: { s: SubagentView }) {
  if (!s.turns.length) return null;
  return (
    <details className="subagent">
      <summary>
        Subagent conversation
        {s.title ? <span className="subagent__title">{s.title}</span> : null}
      </summary>
      <ol className="subagent__turns">
        {s.turns.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are positional
          <li key={i} data-role={t.role}>
            <span className="subagent__who">{t.role === 'user' ? 'Asked' : 'Answered'}</span>
            <p>{t.text}</p>
          </li>
        ))}
      </ol>
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
}: {
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
  const segs = segments(parts);
  const lastText = segs.findLastIndex((s) => s.kind === 'text');
  const calls = new Set(segs.flatMap((s) => (s.kind === 'tool' ? [s.call.call_id] : [])));
  const loose = (subagents ?? []).filter((a) => !a.callId || !calls.has(a.callId));
  return (
    <>
      {segs.map((s, i) => {
        switch (s.kind) {
          case 'text':
            if (holdText) return null;
            return (
              <Streamdown
                key={s.key}
                className="md"
                mode={streaming && i === lastText ? 'streaming' : 'static'}
                isAnimating={streaming && i === lastText}
                parseIncompleteMarkdown={streaming && i === lastText}
                controls={false}
                components={MD_COMPONENTS}
              >
                {linkMarkers(streaming ? s.text : markClaims(s.text, s.base, claims))}
              </Streamdown>
            );
          case 'reasoning':
            return (
              <details key={s.key} className="thinking">
                <summary>Thinking</summary>
                <p>{s.text}</p>
              </details>
            );
          case 'tool':
            return (
              <ToolStep
                key={s.key}
                call={s.call}
                result={s.result}
                waiting={waiting}
                folded={folded}
                subagent={subagents?.find((a) => a.callId === s.call.call_id)}
              />
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
      })}
      {loose.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: transcripts without a call have only their place
        <SubagentConversation key={`sub-${i}`} s={a} />
      ))}
    </>
  );
}
