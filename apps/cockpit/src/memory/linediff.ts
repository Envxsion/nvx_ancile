/**
 * ------------------------------------------------------------------
 *  Title    |  Line diff
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  "Here is what will change" before a memory file is
 *           |  saved, and a reader for git's unified patches.
 *  How      |  Longest common subsequence over lines, after trimming
 *           |  the shared head and tail, which is all a memory edit
 *           |  usually touches. Unchanged runs longer than the context
 *           |  fold into one "n unchanged lines" row.
 * ------------------------------------------------------------------
 */

export type DiffLine =
  | { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number }
  | { kind: 'fold'; count: number };

const LIMIT = 4_000_000; // cells; beyond this, show it as replace-all

export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const A = before.split(/\r?\n/);
  const B = after.split(/\r?\n/);
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (
    tail < A.length - head &&
    tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  )
    tail++;
  const a = A.slice(head, A.length - tail);
  const b = B.slice(head, B.length - tail);

  const mid: DiffLine[] = [];
  if (a.length * b.length > LIMIT) {
    for (const t of a) mid.push({ kind: 'del', text: t });
    for (const t of b) mid.push({ kind: 'add', text: t });
  } else {
    const n = a.length;
    const m = b.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        (L[i] as Uint32Array)[j] =
          a[i] === b[j]
            ? ((L[i + 1] as Uint32Array)[j + 1] as number) + 1
            : Math.max((L[i + 1] as Uint32Array)[j] as number, (L[i] as Uint32Array)[j + 1] as number);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        mid.push({ kind: 'same', text: a[i] as string });
        i++;
        j++;
      } else if (
        j < m &&
        (i >= n || ((L[i] as Uint32Array)[j + 1] as number) >= ((L[i + 1] as Uint32Array)[j] as number))
      ) {
        mid.push({ kind: 'add', text: b[j] as string });
        j++;
      } else {
        mid.push({ kind: 'del', text: a[i] as string });
        i++;
      }
    }
  }

  const all: DiffLine[] = [
    ...A.slice(0, head).map((text) => ({ kind: 'same' as const, text })),
    ...mid,
    ...A.slice(A.length - tail).map((text) => ({ kind: 'same' as const, text })),
  ];
  // Line numbers on both sides.
  let na = 0;
  let nb = 0;
  for (const l of all) {
    if (l.kind === 'fold') continue;
    if (l.kind !== 'add') l.a = ++na;
    if (l.kind !== 'del') l.b = ++nb;
  }
  return fold(all, context);
}

function fold(lines: DiffLine[], context: number): DiffLine[] {
  const changed = lines.map((l) => l.kind === 'add' || l.kind === 'del');
  const keep = lines.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++)
      if (changed[k]) return true;
    return false;
  });
  const out: DiffLine[] = [];
  let run = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (run) out.push({ kind: 'fold', count: run });
      run = 0;
      out.push(l);
    } else run++;
  });
  if (run) out.push({ kind: 'fold', count: run });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/** git's unified diff as rows, file headers dropped. */
export function parsePatch(patch: string): (DiffLine | { kind: 'file'; path: string })[] {
  const out: (DiffLine | { kind: 'file'; path: string })[] = [];
  let a = 0;
  let b = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      out.push({ kind: 'file', path: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1') });
      continue;
    }
    if (
      /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(
        line,
      )
    )
      continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      a = Number(h[1]) - 1;
      b = Number(h[2]) - 1;
      out.push({ kind: 'fold', count: 0 });
      continue;
    }
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), b: ++b });
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), a: ++a });
    else if (line.startsWith(' ')) out.push({ kind: 'same', text: line.slice(1), a: ++a, b: ++b });
  }
  return out;
}
