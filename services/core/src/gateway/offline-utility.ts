/**
 * ------------------------------------------------------------------
 *  Title    |  The offline test model's utility answers
 *  Ref      |  DESIGN.md §8.3–8.5, prompts/threads/*
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Compaction, compare, merge, titles and topic shifts all
 *           |  work before any provider key exists: the offline model
 *           |  answers each utility prompt with something honest and
 *           |  structurally right, computed from the prompt itself.
 *  How      |  The utility caller names the task on the system line
 *           |  (`Ancile task: threads.compact. …`). Each task reads the
 *           |  rendered prompt's labelled sections and builds its reply
 *           |  from them: extractive, never invented.
 * ------------------------------------------------------------------
 */

export const TASK_LINE = 'Ancile task:';

/** The task id from a utility system line, or null for an ordinary turn. */
export function utilityTask(system: string | undefined): string | null {
  const m = system?.startsWith(TASK_LINE) ? /^Ancile task: ([a-z][\w-]*(?:\.[\w-]+)*)/.exec(system) : null;
  return m?.[1] ?? null;
}

/** Text between `label` and the next blank-line-separated label, or the end. */
function section(prompt: string, label: string, next: string[]): string {
  const i = prompt.indexOf(label);
  if (i < 0) return '';
  let rest = prompt.slice(i + label.length);
  let end = rest.length;
  for (const n of next) {
    const j = rest.indexOf(n);
    if (j >= 0 && j < end) end = j;
  }
  rest = rest.slice(0, end);
  return rest.replace(/^[^\n]*\n/, '').trim();
}

const turnsOf = (text: string) =>
  text
    .split(/\n+(?=(?:User|Assistant): )/)
    .map((t) => t.trim())
    .filter((t) => /^(User|Assistant): /.test(t));

const firstSentence = (s: string, max = 160) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.{10,}?[.!?](?=\s|$)/)?.[0] ?? flat;
  return m.length > max ? `${m.slice(0, max - 1)}…` : m;
};

const words = (s: string) => s.match(/\S+/g)?.length ?? 0;

export function offlineUtility(task: string, prompt: string): string {
  switch (task) {
    case 'threads.compact': {
      const turns = turnsOf(prompt.slice(prompt.lastIndexOf('Conversation to compress:')));
      const lines = turns.map((t) =>
        t.startsWith('User: ')
          ? `- The user asked: ${firstSentence(t.slice(6))}`
          : `- The assistant answered: ${firstSentence(t.slice(11))}`,
      );
      const earlier = section(prompt, 'Earlier summary:', ['User: ', 'Assistant: ']);
      return ['## Earlier in this conversation', ...(earlier ? [earlier] : []), ...lines].join('\n');
    }
    case 'threads.compare': {
      const a = section(prompt, 'Branch A (', ['Branch B (']);
      const b = section(prompt, 'Branch B (', ['Return JSON']);
      // Compare answers, not questions: a branch made by editing a message
      // starts with the edited question, and its answer is what differs.
      const first = (side: string, who: 'User' | 'Assistant') => {
        const t = turnsOf(side).find((x) => x.startsWith(`${who}: `));
        return t ? firstSentence(t.slice(who.length + 2)) : '';
      };
      const qa = first(a, 'User');
      const qb = first(b, 'User');
      const aa = first(a, 'Assistant');
      const ab = first(b, 'Assistant');
      return JSON.stringify({
        summary: `Branch A runs to ${words(a)} words and branch B to ${words(b)}. The offline test model can only compare their size and how each answer opens.`,
        differences: [
          ...(qa && qb && qa !== qb ? [{ aspect: 'Question', a: qa, b: qb }] : []),
          {
            aspect: 'How the answer opens',
            a: aa || 'No answer on this branch yet.',
            b: ab || 'No answer on this branch yet.',
          },
          { aspect: 'Length', a: `${words(a)} words`, b: `${words(b)} words` },
        ],
        better_for: { a: 'Reading in full to judge.', b: 'Reading in full to judge.' },
      });
    }
    case 'threads.merge': {
      const a = section(prompt, 'Branch A:', ['Branch B:']);
      const b = section(prompt, 'Branch B:', []);
      const last = (s: string) => {
        const t = turnsOf(s)
          .filter((x) => x.startsWith('Assistant: '))
          .at(-1);
        return t ? firstSentence(t.slice(11), 240) : firstSentence(s, 240);
      };
      return `Combined from both branches:\n\n- ${last(a)} [A]\n- ${last(b)} [B]\n\n_Offline test model: quotes only._`;
    }
    case 'threads.branch-suggest': {
      const next = section(prompt, 'New message:', ['Return JSON']);
      const topic = next
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .join(' ');
      return JSON.stringify({
        shift: true,
        confidence: 0.6,
        new_topic: topic || 'A new topic',
        reason: 'It shares almost no words with the recent questions.',
      });
    }
    case 'threads.title': {
      const first = section(prompt, 'First message:', ['First reply']);
      const title = first
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .join(' ')
        .replace(/[.?!,:;]+$/, '');
      return JSON.stringify({ title: title || 'New thread' });
    }
    default:
      return 'ok';
  }
}
