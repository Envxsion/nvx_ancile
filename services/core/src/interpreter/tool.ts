/**
 * ------------------------------------------------------------------
 *  Title    |  python_run, the code interpreter tool
 *  Ref      |  docs/interpreter.md · DESIGN.md §5.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let a model run Python to calculate, analyse a file
 *           |  attached to the thread, or draw a chart, in plain chat
 *           |  with cloud and local models alike.
 *  How      |  A built-in tool like fs_read: the conductor runs it only
 *           |  after the permission gate (scopes, Auto mode, decide)
 *           |  allowed the call on its real arguments. Action code.run,
 *           |  resource python:thread/<id>. AUTO by default: the code
 *           |  runs with no network, no files but the ones named here,
 *           |  and no way to touch this machine; config/tools.yaml
 *           |  (tools.code.run) can raise it to gated.
 * ------------------------------------------------------------------
 */

import { AncileError, INTERPRETER_LIMITS, type InterpreterFile, PythonRunArgs } from '@nvx/contracts';
import type { ToolScope, ToolSpec } from '../tools/registry';
import type { InterpreterService } from './service';

export interface AttachedFiles {
  /** The files this thread may hand to Python (its notebook's files, within its scope). */
  list(threadId: string | null): Promise<InterpreterFile[]>;
}

const DESCRIPTION = [
  'Run Python 3 code in a sandbox and get back what it printed, any error, and figures.',
  'numpy, pandas, matplotlib, scipy, sympy, networkx, scikit-learn, statsmodels and a few more import on demand; nothing can be installed.',
  'There is no network and no access to this computer. Files attached to this thread can be copied in by name with `files`; they appear in the working folder /data.',
  `Each run starts fresh and may take up to ${INTERPRETER_LIMITS.timeoutS} seconds (timeout_s raises it to ${INTERPRETER_LIMITS.maxTimeoutS}).`,
  'Print what you need to see. matplotlib figures are shown to the person automatically; do not save them to files.',
].join(' ');

/** Pick the named files; an unknown name fails with the names that exist. */
export function pickFiles(available: InterpreterFile[], names: string[] | undefined): InterpreterFile[] {
  if (!names?.length) return [];
  const out: InterpreterFile[] = [];
  for (const n of names) {
    const f =
      available.find((a) => a.name === n) ?? available.find((a) => a.name.toLowerCase() === n.toLowerCase());
    if (!f)
      throw new AncileError({
        code: 'interpreter.file_unknown',
        title: `No file called ${n.slice(0, 120)} is attached to this thread.`,
        hint: available.length
          ? `Attached files: ${available
              .map((a) => a.name)
              .join(', ')
              .slice(0, 600)}.`
          : 'Nothing is attached yet. Add the file to this notebook first.',
        status: 400,
        errorClass: 'permanent',
      });
    out.push(f);
  }
  const total = out.reduce((s, f) => s + f.bytes, 0);
  const big = out.find((f) => f.bytes > INTERPRETER_LIMITS.fileBytes);
  if (big || total > INTERPRETER_LIMITS.filesBytes)
    throw new AncileError({
      code: 'interpreter.files_too_large',
      title: big ? `${big.name} is too large to hand to Python.` : 'Those files are too large together.',
      hint: 'Up to 20 MB a file and 50 MB in all. Use a smaller extract of the data.',
      status: 413,
      errorClass: 'permanent',
    });
  return [...new Map(out.map((f) => [f.source_id, f])).values()];
}

export function pythonTool(service: InterpreterService, files: AttachedFiles): ToolSpec {
  return {
    name: 'python_run',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python code to run.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of files attached to this thread to copy into /data first.',
        },
        timeout_s: {
          type: 'integer',
          minimum: 1,
          maximum: INTERPRETER_LIMITS.maxTimeoutS,
          description: `Seconds the code may run (default ${INTERPRETER_LIMITS.timeoutS}).`,
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    action: 'code.run',
    tier: 'auto',
    destructive: false,
    readOnly: true,
    // The first run may download the runtime: the conductor's 60 s is not enough.
    timeoutMs:
      (INTERPRETER_LIMITS.maxTimeoutS + INTERPRETER_LIMITS.startS + INTERPRETER_LIMITS.claimS) * 1000,
    source: { kind: 'builtin' },
    resource: (_args: unknown, scope?: ToolScope) => `python:thread/${scope?.threadId ?? 'none'}`,
    async execute(raw, ctx) {
      const args = PythonRunArgs.safeParse(raw);
      if (!args.success)
        throw new AncileError({
          code: 'interpreter.bad_args',
          title: 'That python_run call is not valid.',
          hint: `${args.error.issues[0]?.path.join('.') || 'arguments'}: ${args.error.issues[0]?.message ?? 'check the arguments'}`,
          status: 400,
          errorClass: 'permanent',
        });
      const threadId = ctx.scope?.threadId ?? null;
      const chosen = args.data.files?.length ? pickFiles(await files.list(threadId), args.data.files) : [];
      return service.run(
        {
          threadId,
          callId: ctx.callId ?? null,
          code: args.data.code,
          files: chosen,
          ...(args.data.timeout_s && { timeoutS: args.data.timeout_s }),
        },
        ctx.signal,
      );
    },
  };
}
