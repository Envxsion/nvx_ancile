/**
 * ------------------------------------------------------------------
 *  Title    |  Tool step cards
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The card for one tool call, with a body for each kind of
 *           |  call (a diff, a terminal, search hits, a Python run).
 *  How      |  Split from thread/ToolSteps.tsx, which keeps the words,
 *           |  icons and clock every other part of the thread uses, so
 *           |  the first download does not carry the bodies. Parts.tsx
 *           |  loads this on demand (lazyHost) and draws a card of the
 *           |  same height, with the step's own words, until it arrives.
 * ------------------------------------------------------------------
 */

import type { ActivityState, WebHit } from '@nvx/contracts';
import { stepCommand, stepDescription, webHits } from '@nvx/contracts/steps';
import { memo, useContext, useMemo, useState } from 'react';
import { useBackgroundShell } from '../activity/api';
import { AutoRanBadge } from '../auto/AutoCards';
import { OpenInEditor } from '../code/OpenInEditor';
import { ImageGenBody } from '../images/ImageGenBody';
import { PythonBody } from '../interpreter/PythonBody';
import { langOfPath } from '../lib/highlight';
import { between, type StepClock } from '../lib/run';
import type { SubagentView } from '../lib/types';
import { DiffView } from '../memory/DiffView';
import type { DiffLine } from '../memory/linediff';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { CodeBlock, CopyCode } from './Code';
import '../styles/tools.css';
import {
  type Args,
  argsOf,
  backgroundShellState,
  Clamped,
  describe,
  displayPath,
  editRows,
  FAMILY_WORD,
  familyOf,
  host,
  ICONS,
  isBackgroundShell,
  type Kind,
  kindOf,
  matchLines,
  oneLiner,
  ResultText,
  resultLine,
  resultText,
  Since,
  STATUS_ICON,
  STATUS_WORD,
  type StepState,
  Sub,
  SubagentConversation,
  s,
  stepState,
  stripReminders,
  type ToolCall,
  ToolCwd,
  type ToolResult,
  took,
  useOpened,
} from './ToolSteps';

/** Claude Code's Read output ("     1→text") as code and the numbers beside it. */
export function stripGutter(text: string): { code: string; numbers: number[] | null } {
  const lines = text.replace(/\n$/, '').split('\n');
  const re = /^\s*(\d+)(?:→|\t)(.*)$/;
  const hits = lines.map((l) => re.exec(l));
  const filled = lines.filter((l) => l.trim()).length;
  const matched = hits.filter(Boolean).length;
  if (!matched || matched < filled * 0.8) return { code: text, numbers: null };
  const numbers: number[] = [];
  const code: string[] = [];
  let prev = 0;
  hits.forEach((m, i) => {
    if (m) {
      prev = Number(m[1]);
      numbers.push(prev);
      code.push(m[2] ?? '');
    } else {
      numbers.push(prev);
      code.push(lines[i] ?? '');
    }
  });
  return { code: code.join('\n'), numbers };
}

function Failure({ result }: { result: ToolResult }) {
  const text = resultText(result) || result.declined_reason || '';
  if (!text) return null;
  return (
    <div className="tstep__fail">
      <ResultText text={text} />
    </div>
  );
}

/** The file a Read, Edit or Write step is about. */
const stepPath = (a: Args): string | null =>
  s(a.file_path) ?? s(a.path) ?? s(a.filePath) ?? s(a.notebook_path);

function ReadBody({ a, result }: { a: Args; result: ToolResult | undefined }) {
  const cwd = useContext(ToolCwd);
  const text = resultText(result);
  const { code, numbers } = useMemo(() => stripGutter(text), [text]);
  if (!result) return null;
  if (!result.ok) return <Failure result={result} />;
  if (!text.trim()) return <p className="tstep__note">The file is empty.</p>;
  const path = s(a.file_path) ?? s(a.path) ?? s(a.filePath);
  return (
    <>
      <CodeBlock code={code} lang={langOfPath(path)} numbers={numbers ?? true} />
      <OpenInEditor path={path} cwd={cwd} />
    </>
  );
}

function EditBody({ kind, a, result }: { kind: Kind; a: Args; result: ToolResult | undefined }) {
  const rows = useMemo(() => editRows(kind, a), [kind, a]);
  const cwd = useContext(ToolCwd);
  return (
    <>
      {a.replace_all === true ? <p className="tstep__note">Every occurrence</p> : null}
      {rows.length ? (
        <DiffView rows={rows} label="What changed" numbered={false} />
      ) : (
        <p className="tstep__note">No changes recorded.</p>
      )}
      {result && !result.ok ? <Failure result={result} /> : null}
      <OpenInEditor path={stepPath(a)} cwd={cwd} tool={kind} args={a} />
    </>
  );
}

const WRITE_LINES = 40;

function WriteBody({ a, result }: { a: Args; result: ToolResult | undefined }) {
  const [all, setAll] = useState(false);
  const cwd = useContext(ToolCwd);
  const content = (s(a.content) ?? '').replace(/\n$/, '');
  const lines = content ? content.split('\n') : [];
  const rows: DiffLine[] = (all ? lines : lines.slice(0, WRITE_LINES)).map((text, i) => ({
    kind: 'add',
    text,
    b: i + 1,
  }));
  return (
    <>
      {rows.length ? (
        <DiffView rows={rows} label="What was written" numbered={false} />
      ) : (
        <p className="tstep__note">An empty file.</p>
      )}
      {lines.length > WRITE_LINES ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : `Show all ${lines.length.toLocaleString('en-GB')} lines`}
        </button>
      ) : null}
      {result && !result.ok ? <Failure result={result} /> : null}
      <OpenInEditor path={stepPath(a)} cwd={cwd} tool="write" args={a} />
    </>
  );
}

function ShellBody({
  tool,
  a,
  result,
  waiting = false,
}: {
  tool: string;
  a: Args;
  result: ToolResult | undefined;
  waiting?: boolean;
}) {
  const cmd = s(a.command) ?? s(a.cmd) ?? '';
  const ps = tool.toLowerCase() === 'powershell';
  let out = resultText(result);
  const exit = /^Exit code (\d+)\n?/.exec(out);
  if (exit) out = out.slice(exit[0].length);
  return (
    <div className="term" data-failed={(result && !result.ok) || undefined}>
      <div className="term__head">
        <span className="term__shell">{ps ? 'PowerShell' : 'Shell'}</span>
        {s(a.description) ? <span className="term__desc">{s(a.description)}</span> : null}
        {exit ? <span className="term__exit">Exit code {exit[1]}</span> : null}
        {a.run_in_background === true ? <span className="term__exit">In the background</span> : null}
        <CopyCode text={cmd} label="Copy command" />
      </div>
      <pre className="term__cmd">
        <span className="term__prompt" aria-hidden="true">
          {ps ? '>' : '$'}
        </span>
        {cmd}
      </pre>
      {result ? (
        out.trim() ? (
          <ResultText text={out} variant="terminal" />
        ) : (
          <p className="term__quiet">No output</p>
        )
      ) : (
        <p className="term__quiet">{waiting ? 'Waiting for your decision' : 'No output yet'}</p>
      )}
    </div>
  );
}

const MATCH_ROWS = 20;

function MatchesBody({ result, cwd }: { result: ToolResult | undefined; cwd: string | null }) {
  const [all, setAll] = useState(false);
  if (!result) return null;
  if (!result.ok) return <Failure result={result} />;
  const lines = matchLines(resultText(result));
  if (!lines.length) return <p className="tstep__note">Nothing matched.</p>;
  const shown = all ? lines : lines.slice(0, MATCH_ROWS);
  return (
    <>
      <ul className="matches">
        {shown.map((l, i) => {
          const m = /^(.+?):(\d+)[:-](.*)$/.exec(l);
          const key = `${i}-${l.slice(0, 24)}`;
          if (m)
            return (
              <li key={key} data-kind="line">
                <span className="matches__file" title={m[1]}>
                  {displayPath(m[1] as string, cwd)}
                </span>
                <span className="matches__no" data-num>
                  {m[2]}
                </span>
                <span className="matches__text">{(m[3] as string).trim()}</span>
              </li>
            );
          const isPath = /[\\/]/.test(l) && !/\s{2,}/.test(l);
          return (
            <li key={key} data-kind={isPath ? 'file' : 'text'}>
              {isPath ? <Icon name="file" size={12} /> : null}
              <span className={isPath ? 'matches__file' : 'matches__text'} title={isPath ? l : undefined}>
                {isPath ? displayPath(l.trim(), cwd) : l}
              </span>
            </li>
          );
        })}
      </ul>
      {lines.length > MATCH_ROWS ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : `Show all ${lines.length.toLocaleString('en-GB')}`}
        </button>
      ) : null}
    </>
  );
}

function safeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function LinkChip({ url, title }: { url: string; title?: string | null }) {
  const href = safeUrl(url);
  if (!href) return null;
  const u = new URL(href);
  return (
    <a className="link-chip" href={href} target="_blank" rel="noopener noreferrer" title={href}>
      <Icon name="globe" size={11} />
      <span className="link-chip__text">
        {title || `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`}
      </span>
      <Icon name="ext" size={10} />
    </a>
  );
}

/** The words of a search result once its header and its list of links are taken out. */
function searchProse(text: string): string {
  const t = text.trim();
  if (/^[[{]/.test(t))
    try {
      JSON.parse(t);
      return '';
    } catch {
      /* not JSON: read it as text */
    }
  return t
    .replace(/^Web search results for query:.*$/m, '')
    .replace(/^Links:\s*\[.*\]\s*$/m, '')
    .split('\n')
    .filter((l) => !/^\{"(title|type)":/.test(l.trim()))
    .join('\n')
    .trim();
}

function SearchHits({ hits }: { hits: WebHit[] }) {
  return (
    <ul className="web-hits" aria-label="Search results">
      {hits.map((h) => {
        const href = safeUrl(h.url);
        if (!href) return null;
        return (
          <li key={h.url}>
            <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
              {h.title ?? host(href)}
            </a>
            <span className="web-hits__host">{host(href)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function WebBody({ kind, a, result }: { kind: Kind; a: Args; result: ToolResult | undefined }) {
  const [raw, setRaw] = useState(false);
  const text = resultText(result);
  const url = s(a.url);
  const query = s(a.query);
  const hits = kind === 'search' && result?.ok ? webHits(result.result) : [];
  const prose = kind === 'search' ? searchProse(text) : text;
  return (
    <>
      {query ? (
        <p className="tstep__note">
          Query: <span data-mono>{query}</span>
        </p>
      ) : null}
      {url ? (
        <div className="link-chips">
          <LinkChip url={url} />
        </div>
      ) : null}
      {s(a.prompt) ? <p className="tstep__note">Asked: {s(a.prompt)}</p> : null}
      {result && !result.ok ? (
        <Failure result={result} />
      ) : result && raw ? (
        <ResultText text={text || '(empty)'} />
      ) : (
        <>
          {hits.length ? <SearchHits hits={hits} /> : null}
          {result && kind === 'search' && !hits.length && !prose ? (
            <p className="tstep__note">No results came back.</p>
          ) : null}
          {prose ? (
            <Sub label="What came back">
              <Clamped text={prose} />
            </Sub>
          ) : null}
        </>
      )}
      {result?.ok && kind === 'search' ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setRaw((x) => !x)}>
          {raw ? 'Show the list' : 'Show raw'}
        </button>
      ) : null}
    </>
  );
}

const TODO_WORDS: Record<string, string> = {
  completed: 'Done',
  in_progress: 'In progress',
  pending: 'To do',
};

function TodoBody({ a }: { a: Args }) {
  const todos = Array.isArray(a.todos) ? (a.todos as Args[]) : [];
  if (!todos.length) return <p className="tstep__note">The plan is empty.</p>;
  return (
    <ul className="todo" aria-label="Plan">
      {todos.map((t, i) => {
        const status = s(t?.status) ?? 'pending';
        const text = s(t?.content) ?? s(t?.activeForm) ?? '';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the plan is positional
          <li key={i} data-status={status}>
            <span className="todo__box" aria-hidden="true">
              {status === 'completed' ? <Icon name="check" size={11} /> : null}
            </span>
            <span className="sr-only">{TODO_WORDS[status] ?? status}: </span>
            <span className="todo__text">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function AgentBody({
  a,
  result,
  subagent,
}: {
  a: Args;
  result: ToolResult | undefined;
  subagent?: SubagentView | undefined;
}) {
  const prompt = s(a.prompt);
  const report = resultText(result);
  return (
    <>
      {prompt ? (
        <Sub label="What it was asked">
          <Clamped text={prompt} />
        </Sub>
      ) : null}
      {result && !result.ok ? (
        <Failure result={result} />
      ) : report ? (
        <div className="tstep__report">
          <div className="tool-step__k">What it reported</div>
          <Clamped text={report} />
        </div>
      ) : null}
      {subagent ? <SubagentConversation s={subagent} /> : null}
    </>
  );
}

function pretty(v: unknown): { text: string; json: boolean } {
  if (typeof v === 'string') {
    const t = stripReminders(v);
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return { text: JSON.stringify(parsed, null, 2), json: true };
    } catch {
      /* not JSON */
    }
    return { text: t, json: false };
  }
  return { text: JSON.stringify(v, null, 2) ?? '', json: true };
}

function McpBody({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const args = JSON.stringify(call.args ?? {}, null, 2);
  const r = result ? pretty(result.result) : null;
  return (
    <>
      {args !== '{}' ? <CodeBlock code={args} lang="json" title="Input" clamp={16} /> : null}
      {r && result ? (
        result.ok ? (
          r.json ? (
            <CodeBlock code={r.text} lang="json" title="Result" />
          ) : (
            <>
              <div className="tool-step__k">Result</div>
              <ResultText text={r.text} />
            </>
          )
        ) : (
          <Failure result={result} />
        )
      ) : null}
    </>
  );
}

function GenericBody({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  return (
    <>
      <div className="tool-step__k">Input</div>
      <pre data-num>{JSON.stringify(call.args, null, 2)}</pre>
      {result ? (
        <>
          <div className="tool-step__k">{result.ok ? 'Result' : 'What happened'}</div>
          <ResultText text={resultText(result)} />
        </>
      ) : null}
    </>
  );
}

/**
 * The lab's own lower-case tools keep the plain Input and Result view their
 * results were written for, except the ones read the same way everywhere
 * (a shell, an edit, a search, a web page).
 */
function plainView(tool: string, kind: Kind): boolean {
  const lab = tool === tool.toLowerCase() && kind !== 'mcp';
  return lab && !['shell', 'edit', 'grep', 'glob', 'search', 'fetch'].includes(kind);
}

function Body({
  call,
  result,
  subagent,
  cwd,
  waiting,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  subagent?: SubagentView | undefined;
  cwd: string | null;
  waiting: boolean;
}) {
  const kind = kindOf(call.tool);
  const a = argsOf(call);
  // The lab's own tools keep the plain view their results were written for.
  if (kind === 'python') return <PythonBody call={call} result={result} />;
  if (kind === 'image') return <ImageGenBody call={call} result={result} />;
  if (plainView(call.tool, kind)) return <GenericBody call={call} result={result} />;
  switch (kind) {
    case 'read':
      return <ReadBody a={a} result={result} />;
    case 'edit':
    case 'multiedit':
    case 'notebook':
      return <EditBody kind={kind} a={a} result={result} />;
    case 'write':
      return <WriteBody a={a} result={result} />;
    case 'shell':
      return <ShellBody tool={call.tool} a={a} result={result} waiting={waiting} />;
    case 'grep':
    case 'glob':
    case 'list':
      return <MatchesBody result={result} cwd={cwd} />;
    case 'fetch':
    case 'search':
      return <WebBody kind={kind} a={a} result={result} />;
    case 'todo':
      return <TodoBody a={a} />;
    case 'agent':
      return <AgentBody a={a} result={result} subagent={subagent} />;
    case 'mcp':
      return <McpBody call={call} result={result} />;
    default:
      return (
        <>
          <GenericBody call={call} result={result} />
          {subagent ? <SubagentConversation s={subagent} /> : null}
        </>
      );
  }
}

/**
 * A step's time: counting from its live clock while it runs, then how long
 * it took, from the result's duration_ms (the saved message), or its live
 * clock while the answer is still on screen. Nothing when neither is known.
 */
function StepTime({
  clock,
  result,
  running,
}: {
  clock: StepClock | undefined;
  result: ToolResult | undefined;
  running: boolean;
}) {
  if (running)
    return clock ? <Since start={clock.start} className="tool-step__time" label="Running for" /> : null;
  const ms = result?.duration_ms ?? (clock?.end ? between(clock.start, clock.end) : undefined);
  const text = ms === undefined ? '' : took(ms);
  if (!text) return null;
  return (
    <span className="tool-step__time" data-num title={`Took ${text}`}>
      <span className="sr-only">Took </span>
      {text}
    </span>
  );
}

/** Steps whose body shows nothing of the input until the result is in: they show it meanwhile. */
const INPUT_WHILE_PENDING = new Set<Kind>([
  'read',
  'grep',
  'glob',
  'list',
  'skill',
  'toolsearch',
  'monitor',
  'delete',
  'patch',
]);

/** What an opened step without a result says, with its input where the body would not show it. */
function Pending({
  call,
  kind,
  state,
  live,
}: {
  call: ToolCall;
  kind: Kind;
  state: StepState;
  live: boolean;
}) {
  const args = JSON.stringify(call.args ?? {}, null, 2);
  const word =
    state === 'waiting'
      ? 'Waiting for your decision.'
      : live
        ? 'No result yet.'
        : 'No result was recorded for this step.';
  return (
    <>
      {INPUT_WHILE_PENDING.has(kind) && !plainView(call.tool, kind) && args !== '{}' ? (
        <CodeBlock code={args} lang="json" title="Input" clamp={16} />
      ) : null}
      {kind === 'shell' ? null : <p className="tstep__note tstep__pending">{word}</p>}
    </>
  );
}

export interface ToolStepProps {
  call: ToolCall;
  result: ToolResult | undefined;
  waiting: boolean;
  /** The approval this step waits on: its "Waiting for your decision" opens exactly that one. */
  approvalId?: string | null;
  subagent?: SubagentView | undefined;
  /** Settings → Reading: tool steps start as one line. */
  folded: boolean;
  /** When the step started and ended, while its answer is being written. */
  clock?: StepClock | undefined;
  /** The answer is still being written. */
  live?: boolean;
}

/** Memoised: while an answer streams, only the steps whose call, result or clock changed draw again. */
export const ToolStep = memo(function ToolStep(props: ToolStepProps) {
  return isBackgroundShell(props.call) && props.result?.ok ? (
    <BackgroundShellStep {...props} />
  ) : (
    <ToolStepView {...props} shell={undefined} />
  );
});

/** A background shell's step, with its state from Activity. */
function BackgroundShellStep(props: ToolStepProps) {
  const shell = useBackgroundShell(props.call.call_id, true);
  return <ToolStepView {...props} shell={shell} />;
}

function ToolStepView({
  call,
  result,
  waiting,
  folded,
  subagent,
  clock,
  live = false,
  shell,
  approvalId = null,
}: ToolStepProps & { shell: ActivityState | 'gone' | null | undefined }) {
  const cwd = useContext(ToolCwd);
  const background = shell !== undefined;
  const state = background
    ? backgroundShellState(stepState(result, waiting), shell)
    : stepState(result, waiting);
  const line = describe(call, result, state, cwd);
  const kind = kindOf(call.tool);
  const family = familyOf(kind);
  // The call's own words ("Reading the data models") lead; what it ran sits under them.
  const own = stepDescription(call.tool, call.args);
  const under = own ? (stepCommand(call.tool, call.args) ?? oneLiner(line)) : null;
  // What came back, in a line; a background shell's launch output says nothing of how it went.
  const said = useMemo(
    () => (background ? null : resultLine(call, result, state)),
    [background, call, result, state],
  );
  const detail = background
    ? state === 'running'
      ? 'Running in the background'
      : state === 'failed'
        ? 'Failed in the background'
        : 'Ran in the background'
    : state === 'waiting'
      ? 'Waiting for your decision'
      : state === 'declined'
        ? result?.declined_reason || null
        : said;
  // A Python run is read for its output and figures: it stays open whatever the setting.
  const openByDefault = !folded || state === 'waiting' || kind === 'python' || kind === 'image';
  const [shown, onToggle] = useOpened(openByDefault);
  return (
    <details
      className="tool-step"
      data-call-id={call.call_id}
      data-state={state}
      data-kind={kind}
      data-family={family}
      data-described={own ? true : undefined}
      open={openByDefault || undefined}
      onToggle={onToggle}
    >
      <summary title={line.full ?? under ?? undefined}>
        <Icon name={ICONS[kind]} size={13} className="tool-step__icon" label={FAMILY_WORD[family]} />
        <span className="tool-step__text">
          {own ? (
            <span className="tool-step__label">
              <span className="tool-step__title">{own}</span>
              {line.badge ? <span className="tool-step__badge">{line.badge}</span> : null}
            </span>
          ) : (
            <span className="tool-step__label">
              <span className="tool-step__verb">{line.verb}</span>{' '}
              {line.badge ? <span className="tool-step__badge">{line.badge}</span> : null}{' '}
              {line.target ? (
                <span className="tool-step__target" data-mono={line.mono || undefined}>
                  {line.target}
                </span>
              ) : null}{' '}
              {line.where ? (
                <span className="tool-step__where">
                  in <span data-mono>{line.where}</span>
                </span>
              ) : null}
            </span>
          )}
          {under ? (
            <span className="tool-step__cmd" data-mono={kind === 'shell' || kind === 'monitor' || undefined}>
              {under}
            </span>
          ) : null}
        </span>
        {state === 'waiting' && approvalId ? (
          <span className="tool-step__detail">
            <button
              type="button"
              className="link-btn tool-step__ask"
              onClick={(e) => {
                // Open the decision, not the step.
                e.preventDefault();
                e.stopPropagation();
                useUi.getState().setApproval(true, approvalId);
              }}
            >
              Waiting for your decision
            </button>
          </span>
        ) : detail ? (
          <span className="tool-step__detail" title={detail}>
            {detail}
          </span>
        ) : null}
        {line.meta ? (
          <span className="tool-step__meta" data-num>
            {line.meta}
          </span>
        ) : null}
        {background ? null : <StepTime clock={clock} result={result} running={!result && live} />}
        <AutoRanBadge callId={call.call_id} />
        <span className="tool-step__status" title={STATUS_WORD[state]}>
          <Icon name={STATUS_ICON[state]} size={12} />
          <span className="sr-only">{STATUS_WORD[state]}</span>
        </span>
      </summary>
      <div className="tool-step__body">
        {shown ? (
          <>
            <Body call={call} result={result} subagent={subagent} cwd={cwd} waiting={state === 'waiting'} />
            {result ? null : <Pending call={call} kind={kind} state={state} live={live} />}
          </>
        ) : null}
      </div>
    </details>
  );
}
