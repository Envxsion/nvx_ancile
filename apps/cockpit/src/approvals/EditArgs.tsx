/**
 * ------------------------------------------------------------------
 *  Title    |  Edit before allowing
 *  Ref      |  docs/api.md (Answer an approval) · docs/claude-code.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Change what a tool call will do before letting it run
 *           |  once: narrow a shell command, fix an edit, shorten a
 *           |  file, point a fetch elsewhere. The permission is
 *           |  decided again on what you change.
 *  How      |  A structured editor for the tools people change most
 *           |  (Bash and PowerShell, Edit with a live diff, MultiEdit,
 *           |  Write, WebFetch); anything else is a JSON editor that
 *           |  says when the JSON is not valid. Fields the tool must
 *           |  keep (the file's path, a command's description) are
 *           |  shown, not editable.
 *  Note     |  Works for any approval that says args_editable, not
 *           |  only Claude Code's.
 * ------------------------------------------------------------------
 */

import { useId, useMemo, useState } from 'react';
import { DiffView } from '../memory/DiffView';
import { lineDiff } from '../memory/linediff';

export type ArgsKind = 'shell' | 'edit' | 'multiedit' | 'write' | 'fetch' | 'json';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Which editor fits this call: by the tool's name, and only when its arguments look as expected. */
export function argsKind(tool: string, args: unknown): ArgsKind {
  if (!isObj(args)) return 'json';
  const name = (tool.split(/[.:/]/).pop() ?? tool).toLowerCase();
  if ((name === 'bash' || name === 'powershell') && typeof args.command === 'string') return 'shell';
  if (name === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string')
    return 'edit';
  if (name === 'multiedit' && Array.isArray(args.edits) && args.edits.every(isObj)) return 'multiedit';
  if (name === 'write' && typeof args.content === 'string') return 'write';
  if (name === 'webfetch' && typeof args.url === 'string') return 'fetch';
  return 'json';
}

/** Deep equality for plain JSON values, to tell whether anything changed. */
export function sameArgs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ArgsEditor({
  tool,
  original,
  value,
  onChange,
}: {
  tool: string;
  original: unknown;
  value: unknown;
  /** `valid` false: the JSON does not parse yet; `value` is the last good one. */
  onChange: (value: unknown, valid: boolean) => void;
}) {
  const kind = argsKind(tool, original);
  const v = isObj(value) ? value : {};
  const set = (k: string, x: unknown) => onChange({ ...v, [k]: x }, true);
  switch (kind) {
    case 'shell':
      return <ShellEditor v={v} set={set} />;
    case 'edit':
      return <EditEditor v={v} set={set} />;
    case 'multiedit':
      return <MultiEditEditor v={v} set={set} />;
    case 'write':
      return (
        <div className="args-edit">
          <ReadOnly label="File" value={str(v.file_path)} />
          <Area label="Content" value={str(v.content)} onChange={(x) => set('content', x)} rows={10} />
        </div>
      );
    case 'fetch':
      return (
        <div className="args-edit">
          <Field label="Address" value={str(v.url)} onChange={(x) => set('url', x)} />
          {'prompt' in v ? (
            <Area
              label="What to look for"
              value={str(v.prompt)}
              onChange={(x) => set('prompt', x)}
              rows={3}
            />
          ) : null}
        </div>
      );
    default:
      return <JsonEditor original={original} onChange={onChange} />;
  }
}

function ShellEditor({ v, set }: { v: Obj; set: (k: string, x: unknown) => void }) {
  return (
    <div className="args-edit">
      <Area label="Command" value={str(v.command)} onChange={(x) => set('command', x)} rows={3} mono />
      {v.description ? <ReadOnly label="What it is for" value={str(v.description)} plain /> : null}
    </div>
  );
}

function EditEditor({ v, set }: { v: Obj; set: (k: string, x: unknown) => void }) {
  const before = str(v.old_string);
  const after = str(v.new_string);
  const rows = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <div className="args-edit">
      <ReadOnly label="File" value={str(v.file_path)} />
      {v.replace_all === true ? <p className="args-edit__note">Replaces every occurrence.</p> : null}
      <Area label="Replace this" value={before} onChange={(x) => set('old_string', x)} rows={4} mono />
      <Area label="With this" value={after} onChange={(x) => set('new_string', x)} rows={4} mono />
      <div className="args-edit__diff">
        <span className="args-edit__label">What the edit will do</span>
        <DiffView rows={rows} label="What the edit will do" numbered={false} />
      </div>
    </div>
  );
}

function MultiEditEditor({ v, set }: { v: Obj; set: (k: string, x: unknown) => void }) {
  const edits = (Array.isArray(v.edits) ? v.edits : []).filter(isObj);
  const change = (i: number, k: string, x: string) =>
    set(
      'edits',
      edits.map((e, j) => (j === i ? { ...e, [k]: x } : e)),
    );
  return (
    <div className="args-edit">
      <ReadOnly label="File" value={str(v.file_path)} />
      {edits.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: edits are positional and never reordered here
        <fieldset key={i} className="args-edit__group">
          <legend>Change {i + 1}</legend>
          <Area
            label="Replace this"
            value={str(e.old_string)}
            onChange={(x) => change(i, 'old_string', x)}
            rows={3}
            mono
          />
          <Area
            label="With this"
            value={str(e.new_string)}
            onChange={(x) => change(i, 'new_string', x)}
            rows={3}
            mono
          />
        </fieldset>
      ))}
    </div>
  );
}

function JsonEditor({
  original,
  onChange,
}: {
  original: unknown;
  onChange: (v: unknown, valid: boolean) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(original ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <div className="args-edit">
      <label className="args-edit__field" htmlFor={id}>
        <span className="args-edit__label">Arguments (JSON)</span>
        <textarea
          id={id}
          className="input input--mono args-edit__area"
          rows={8}
          spellCheck={false}
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            try {
              const parsed: unknown = JSON.parse(t);
              setError(null);
              onChange(parsed, true);
            } catch {
              setError('This is not valid JSON yet. Check the brackets, quotes and commas.');
              onChange(undefined, false);
            }
          }}
        />
      </label>
      {error ? (
        <p id={`${id}-err`} className="args-edit__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Area({
  label,
  value,
  onChange,
  rows,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <label className="args-edit__field" htmlFor={id}>
      <span className="args-edit__label">{label}</span>
      <textarea
        id={id}
        className={`input args-edit__area${mono ? ' input--mono' : ''}`}
        rows={rows}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <label className="args-edit__field" htmlFor={id}>
      <span className="args-edit__label">{label}</span>
      <input
        id={id}
        className="input input--mono"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ReadOnly({ label, value, plain = false }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="args-edit__field">
      <span className="args-edit__label">{label}</span>
      <span className="args-edit__fixed" data-num={plain ? undefined : true}>
        {value || '(none)'}
      </span>
    </div>
  );
}
