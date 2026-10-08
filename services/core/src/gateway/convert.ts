/**
 * ------------------------------------------------------------------
 *  Title    |  Parts → provider messages
 *  Ref      |  DESIGN.md §8.6 (lossless model switching)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Ancile stores a whole assistant turn as one message:
 *           |  text, tool calls, their results, more text. Providers
 *           |  want that as alternating assistant and tool messages.
 *           |  This is the one place that translation happens, so a
 *           |  thread started on one provider continues on another
 *           |  with its tool history intact.
 *  How      |  Walk the parts in order. Text and tool calls accumulate
 *           |  into an assistant message; a tool result closes it and
 *           |  opens (or extends) a tool message. Reasoning, seams and
 *           |  citation markers are display-only and are not replayed.
 *           |  Per target: a model without tools gets past tool calls
 *           |  as text; images reach a model as their caption, marked.
 *           |  TODO(phase-5): real image input for vision models.
 *           |  The output is the AI SDK's ModelMessage shape, kept
 *           |  structural here so this file has no SDK import.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import type { ModelMessage } from './types';

type SdkContent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output:
        | { type: 'json'; value: unknown }
        | { type: 'text'; value: string }
        | { type: 'error-text'; value: string };
    };

export type SdkMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: SdkContent[] }
  | { role: 'tool'; content: SdkContent[] };

/** JSON-safe value for a tool result: undefined and functions do not survive the wire. */
function jsonValue(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

function expandAssistant(parts: Part[]): SdkMessage[] {
  const out: SdkMessage[] = [];
  const toolNames = new Map<string, string>();
  let assistant: SdkContent[] = [];
  let tool: SdkContent[] = [];

  const flushAssistant = () => {
    if (assistant.length) out.push({ role: 'assistant', content: assistant });
    assistant = [];
  };
  const flushTool = () => {
    if (tool.length) out.push({ role: 'tool', content: tool });
    tool = [];
  };

  for (const p of parts) {
    if (p.type === 'text') {
      if (!p.text) continue;
      flushTool();
      const last = assistant.at(-1);
      if (last?.type === 'text') last.text += p.text;
      else assistant.push({ type: 'text', text: p.text });
    } else if (p.type === 'tool_call') {
      flushTool();
      toolNames.set(p.call_id, p.tool);
      assistant.push({
        type: 'tool-call',
        toolCallId: p.call_id,
        toolName: p.tool,
        input: jsonValue(p.args) ?? {},
      });
    } else if (p.type === 'tool_result') {
      flushAssistant();
      const toolName = toolNames.get(p.call_id) ?? 'tool';
      const output =
        p.declined_reason !== undefined
          ? {
              type: 'error-text' as const,
              value: `The user declined this call${p.declined_reason ? `: ${p.declined_reason}` : '.'}`,
            }
          : p.ok
            ? { type: 'json' as const, value: jsonValue(p.result) }
            : {
                type: 'error-text' as const,
                value: typeof p.result === 'string' ? p.result : JSON.stringify(p.result),
              };
      tool.push({ type: 'tool-result', toolCallId: p.call_id, toolName, output });
    }
  }
  flushAssistant();
  flushTool();
  return out;
}

/** What the target model can take, so parts are normalised for it (DESIGN.md §8.6). */
export interface TargetCaps {
  /** Without tools, past tool calls and results are replayed as text. */
  tools: boolean;
}

/** A tool exchange as plain text, for a model that cannot take tool parts. */
export function toolsAsText(parts: Part[]): Part[] {
  return parts.map((p): Part => {
    if (p.type === 'tool_call')
      return { type: 'text', text: `\n[Called ${p.tool} with ${JSON.stringify(jsonValue(p.args) ?? {})}]\n` };
    if (p.type === 'tool_result') {
      const body =
        p.declined_reason !== undefined
          ? `declined${p.declined_reason ? `: ${p.declined_reason}` : ''}`
          : typeof p.result === 'string'
            ? p.result
            : JSON.stringify(jsonValue(p.result));
      return { type: 'text', text: `\n[${p.ok ? 'Result' : 'Failed'}: ${body.slice(0, 4_000)}]\n` };
    }
    return p;
  });
}

/** A user message as text: images the model cannot see arrive as their caption, marked as such. */
function userText(parts: Part[]): string {
  return parts
    .flatMap((p) => {
      if (p.type === 'text') return [p.text];
      if (p.type === 'image')
        return [p.caption ? `\n[Image, described: ${p.caption}]\n` : '\n[Image not shown]\n'];
      if (p.type === 'file') return [`\n[Attached file: ${p.name}]\n`];
      return [];
    })
    .join('');
}

export function toSdkMessages(messages: ModelMessage[], caps: TargetCaps = { tools: true }): SdkMessage[] {
  const out: SdkMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content });
    else if (m.role === 'user') {
      const text = m.parts ? userText(m.parts) : m.content;
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      if (m.parts) out.push(...expandAssistant(caps.tools ? m.parts : toolsAsText(m.parts)));
      else if (m.content) out.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
    }
    // Stored `tool` role messages are folded into the assistant turn above.
  }
  // A dangling tool call with no result would be rejected by every provider.
  const answered = new Set(
    out.flatMap((m) =>
      m.role === 'tool' ? m.content.map((c) => (c.type === 'tool-result' ? c.toolCallId : '')) : [],
    ),
  );
  return out
    .map((m) =>
      m.role === 'assistant'
        ? { ...m, content: m.content.filter((c) => c.type !== 'tool-call' || answered.has(c.toolCallId)) }
        : m,
    )
    .filter((m) => m.role !== 'assistant' || m.content.length > 0);
}
