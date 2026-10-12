/**
 * ------------------------------------------------------------------
 *  Title    |  An agent's edit, before and after
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The Changes tab of the code editor: what a file looked
 *           |  like before an agent's Edit, MultiEdit or Write, next
 *           |  to what it looks like now.
 *  How      |  The tool call only carries the replaced snippets. The
 *           |  whole file before is rebuilt by undoing each edit on
 *           |  the file as it is now, last edit first, when its new
 *           |  text appears exactly once (or replace_all was used).
 *           |  When that cannot be done safely (the file changed
 *           |  again since, or the text repeats), the snippets alone
 *           |  are compared, and the tab says so.
 * ------------------------------------------------------------------
 */

export interface AgentEdit {
  /** Replacements in the order they were made. */
  edits: { before: string; after: string }[];
  replaceAll: boolean;
  /** A Write: the whole new content (what was there before is not recorded). */
  written: string | null;
}

export interface EditDiff {
  before: string;
  after: string;
  /** True when both sides are the whole file; false when only the snippets are compared. */
  whole: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The edit an Edit, MultiEdit or Write call made, from its arguments; null for any other call. */
export function editFromArgs(tool: string, args: unknown): AgentEdit | null {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const t = tool.toLowerCase();
  if (Array.isArray(a.edits)) {
    const edits = a.edits.flatMap((e) => {
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      const before = str(o.old_string) ?? str(o.oldString);
      const after = str(o.new_string) ?? str(o.newString);
      return before !== null && after !== null ? [{ before, after }] : [];
    });
    return edits.length ? { edits, replaceAll: a.replace_all === true, written: null } : null;
  }
  const before = str(a.old_string) ?? str(a.oldString);
  const after = str(a.new_string) ?? str(a.newString);
  if (before !== null && after !== null)
    return { edits: [{ before, after }], replaceAll: a.replace_all === true, written: null };
  const content = str(a.content);
  if (content !== null && (t.includes('write') || t === 'create'))
    return { edits: [], replaceAll: false, written: content };
  return null;
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Before and after for the Changes tab, given the file as it is now. */
export function editDiff(current: string | null, edit: AgentEdit): EditDiff {
  if (edit.written !== null) return { before: '', after: edit.written, whole: false };
  const snippets: EditDiff = {
    before: edit.edits.map((e) => e.before).join('\n\n'),
    after: edit.edits.map((e) => e.after).join('\n\n'),
    whole: false,
  };
  if (current === null) return snippets;
  let text = current;
  for (const e of [...edit.edits].reverse()) {
    const n = count(text, e.after);
    if (n === 0 || (n > 1 && !edit.replaceAll)) return snippets;
    text = edit.replaceAll ? text.split(e.after).join(e.before) : text.replace(e.after, () => e.before);
  }
  return { before: text, after: current, whole: true };
}
