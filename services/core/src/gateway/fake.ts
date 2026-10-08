/**
 * ------------------------------------------------------------------
 *  Title    |  Fake provider and the offline test model
 *  Ref      |  ROADMAP.md (Phase 2 test support)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A deterministic model. Tests use it to exercise every
 *           |  self-healing path offline; the dev stack serves it as
 *           |  "Offline test model" so Ancile is usable before any
 *           |  provider key exists.
 *  How      |  Behaviour comes from the model's provider_model string:
 *           |    echo                 stream the last user message back
 *           |    backup               echo, but a directive it cannot obey
 *           |                         is explained rather than parroted
 *           |    say:<text>           stream <text>
 *           |    fail:500             throw a 500 before any output
 *           |    fail:timeout         throw a timeout before any output
 *           |    fail:auth            throw a 401
 *           |    refusal              open with a refusal
 *           |    filter               finish with content_filter
 *           |    overflow             throw a context-length error
 *           |    break:<n>:<text>     stream n words of <text>, then drop
 *           |    script               obey directives in the message:
 *           |      /tool <name> <json>   call a tool, then report on it
 *           |      /fail <500|timeout|auth|refusal>
 *           |      /slow                 one word every 150 ms
 *           |      /say <text>           answer exactly <text>
 *           |    Utility prompts (system line "Ancile task: <id>") are
 *           |    answered by offline-utility.ts for script and backup.
 *  Note     |  Directives are only read from the latest user message
 *           |  and only by `script`, so a fallback model with
 *           |  behaviour `echo` answers a `/fail` turn normally, which
 *           |  is the point.
 * ------------------------------------------------------------------
 */

import type { ModelConfig, Part } from '@nvx/contracts';
import { ClassifiedError, classifyStatus } from '@nvx/resilience';
import { structuredReply } from './fake-structured';
import { offlineUtility, utilityTask } from './offline-utility';
import type { ModelClient, ModelMessage, ModelRequest, StreamChunk } from './types';

export function fakeModel(id: string, behaviour: string, family = 'fake'): ModelConfig {
  return {
    id: `fake/${id}`,
    provider: 'fake',
    provider_model: behaviour,
    display_name: id,
    via: 'direct',
    family,
    context_window: 32_000,
    max_output: 4_000,
    capabilities: ['tools'],
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    enabled: true,
  };
}

/** The models the dev stack adds when ANCILE_OFFLINE_MODELS is on. */
export const OFFLINE_MODELS: ModelConfig[] = [
  { ...fakeModel('test', 'script', 'offline'), id: 'offline/test', display_name: 'Offline test model' },
  { ...fakeModel('echo', 'backup', 'offline-echo'), id: 'offline/echo', display_name: 'Offline echo' },
];

const httpError = (status: number, message: string) =>
  new ClassifiedError(classifyStatus(status, message), message, { status });

const words = (t: string) => t.split(/(?<= )/);

function textOf(m: ModelMessage | undefined): string {
  if (!m) return '';
  if (m.parts) return m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  return m.content;
}

type ToolResult = Extract<Part, { type: 'tool_result' }>;

/** Tool results the model has been given since the latest user message. */
function resultsSinceUser(messages: ModelMessage[]): ToolResult[] {
  const out: ToolResult[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ModelMessage;
    if (m.role === 'user') break;
    for (const p of m.parts ?? []) if (p.type === 'tool_result') out.unshift(p);
  }
  return out;
}

function preview(value: unknown, max = 600): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const OFFLINE_INTRO =
  "I'm the offline test model. I can't think, but I can stream, call tools and fail on request, so you can try NVX Ancile before adding a provider key in Settings → Models.";

function describeResults(results: ToolResult[]): string {
  return results
    .map((r) =>
      r.declined_reason !== undefined
        ? `You declined that, so I left it alone${r.declined_reason ? ` (${r.declined_reason})` : ''}.`
        : r.ok
          ? `The tool finished. It returned:\n\n\`\`\`\n${preview(r.result)}\n\`\`\``
          : `The tool failed: ${preview(r.result, 300)}`,
    )
    .join('\n\n');
}

export interface FakeProviderOptions {
  /** Delay between words. 0 in unit tests; a little in the dev stack so streaming is visible. */
  wordDelayMs?: number;
}

export class FakeProvider implements ModelClient {
  readonly calls: { model: string; req: ModelRequest }[] = [];
  private readonly delay: number;

  constructor(opts: FakeProviderOptions = {}) {
    this.delay = opts.wordDelayMs ?? 0;
  }

  async *stream(model: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.calls.push({ model: model.id, req });
    let b = model.provider_model;
    let delay = this.delay;
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const prompt = textOf(lastUser).trim();
    const usage = {
      inputTokens: Math.ceil(req.messages.reduce((n, m) => n + textOf(m).length, 0) / 4),
      outputTokens: 0,
    };
    const finish = (reason = 'stop'): StreamChunk => ({ type: 'finish', finishReason: reason, usage });

    // Structured prompts (memory capture, fact-check) get JSON; utility jobs
    // (compact, compare, merge…) are answered from the prompt itself.
    let text: string | undefined =
      b === 'script' || b === 'backup' ? (structuredReply(prompt) ?? undefined) : undefined;
    const task = utilityTask(req.system);
    if (text === undefined && task && (b === 'script' || b === 'backup')) text = offlineUtility(task, prompt);
    if (text === undefined && b === 'script') {
      const results = resultsSinceUser(req.messages);
      const directive = /^\/(\w+)\s*([\s\S]*)$/.exec(prompt);
      if (/(^|\n)\/slow\b/.test(prompt)) delay = Math.max(delay, 150);
      if (results.length) {
        text = describeResults(results);
      } else if (directive?.[1] === 'tool') {
        const m = /^(\S+)\s*([\s\S]*)$/.exec(directive[2] ?? '');
        const tool = m?.[1] ?? 'tool';
        let args: unknown = {};
        try {
          args = m?.[2] ? JSON.parse(m[2]) : {};
        } catch {
          args = { input: m?.[2] };
        }
        yield { type: 'text', delta: `Calling \`${tool}\`.\n\n` };
        yield { type: 'tool_call', callId: `call_${req.messages.length}_${tool}`, tool, args };
        yield finish('tool-calls');
        return;
      } else if (directive?.[1] === 'fail') {
        const kind = (directive[2] ?? '').trim();
        b = kind === 'refusal' ? 'refusal' : `fail:${kind || '500'}`;
      } else if (directive?.[1] === 'say') {
        text = directive[2] ?? '';
      } else if (/^\[1\] /m.test(req.system ?? '')) {
        // Grounded: quote the first sentence of the top passages and cite them,
        // so notebooks and citations can be tried without a key.
        const passages = [...(req.system ?? '').matchAll(/^\[(\d+)\] ([^\n]*)\n"""\n([\s\S]*?)\n"""/gm)];
        const lines = passages.slice(0, 3).map((p) => {
          // Headings are where a passage sits, not what it says.
          p[3] = (p[3] ?? '').replace(/^#{1,6}[^\n]*$/gm, '');
          const first =
            (p[3] ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .match(/^.{20,240}?[.!?](?=\s|$)/)?.[0] ??
            (p[3] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
          return `${first} [${p[1]}]`;
        });
        text = `From your sources:\n\n${lines.join('\n\n')}\n\n_Offline test model: quotes only._`;
      } else {
        const body = prompt.replace(/(^|\n)\/slow\b\s*/g, '$1').trim();
        text = `${OFFLINE_INTRO}\n\nYou wrote:\n\n> ${body.split('\n').join('\n> ')}`;
      }
    }

    if (b === 'fail:500') throw httpError(500, 'upstream exploded');
    if (b === 'fail:timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (b === 'fail:auth') throw httpError(401, 'invalid x-api-key');
    if (b === 'overflow') throw httpError(400, 'prompt is too long: 210000 tokens > 200000 maximum');
    if (b === 'filter') {
      yield finish('content-filter');
      return;
    }

    let breakAfter = Number.POSITIVE_INFINITY;
    if (text === undefined) {
      if (b === 'echo') text = prompt;
      else if (b === 'backup')
        text = prompt.startsWith('/')
          ? `I'm Offline echo, the backup model. I can't follow \`${prompt.split(/\s/)[0]}\`, so I can only repeat what you wrote:\n\n> ${prompt.split('\n').join('\n> ')}`
          : prompt;
      else if (b === 'refusal') text = "I'm sorry, but I can't help with that request.";
      else if (b.startsWith('say:')) text = b.slice(4);
      else if (b.startsWith('break:')) {
        const [, n, ...rest] = b.split(':');
        breakAfter = Number(n);
        text = rest.join(':');
      } else text = 'ok';
    }

    let i = 0;
    for (const w of words(text)) {
      if (signal.aborted) return;
      if (i++ >= breakAfter) throw httpError(502, 'connection reset mid-stream');
      if (delay) await new Promise((r) => setTimeout(r, delay));
      usage.outputTokens += 1;
      yield { type: 'text', delta: w };
    }
    yield finish();
  }
}
