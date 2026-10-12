/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: hard floors
 *  Ref      |  docs/auto-mode.md (Floors)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The deterministic rules Auto mode checks before any
 *           |  reviewer is asked and again after it answers: the scope,
 *           |  writes outside the workspace, recursive deletes, secrets
 *           |  and protected paths, dangerous shell, data leaving the
 *           |  machine (a key, or a lot of text in a web address), and
 *           |  text that tries to talk its way past review
 *           |  (instructions, "this is safe", invisible or look-alike
 *           |  characters).
 *  How      |  Pure. Each rule returns `block` (never runs) or `ask`
 *           |  (a person decides); the strictest hit wins. Text is
 *           |  scanned after NFKC folding with invisible characters
 *           |  removed, so a split or disguised phrase still matches.
 *  Note     |  A false hit only asks; a missed one meets the reviewer.
 *           |  Both lists err on the side of asking.
 * ------------------------------------------------------------------
 */

import type { EffectiveScope } from '@nvx/contracts';
import { checkToolCall } from '../../scopes/resolve';
import { scheme } from '../normalize';

export interface AutoCall {
  principal: string;
  /** The tool's own name, when the caller knows it (Bash, fs_write, …). */
  tool?: string;
  action: string;
  /** The normalised resource the permission decision used. */
  resource: string;
  outsideRoot: boolean;
  destructive: boolean;
  /** The real arguments, as data. Only scanned here; never logged. */
  args?: unknown;
}

export interface FloorHit {
  verdict: 'block' | 'ask';
  rule: string;
  reason: string;
}

/* ---- text helpers ---------------------------------------------------------- */

/** Zero-width, joiners, word joiner, BOM, soft hyphen, and the Unicode tag block. */
const INVISIBLE = /[­᠎​-‏⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/gu;
/** Bidirectional overrides and isolates (Trojan Source). */
const BIDI = /[‪-‮⁦-⁩]/u;
const LATIN = /\p{Script=Latin}/u;
const CONFUSABLE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

/** Every string inside a value, flattened (keys too), capped so a huge write stays cheap. */
export function textOf(value: unknown, cap = 200_000): string {
  const out: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number) => {
    if (size > cap || depth > 12) return;
    if (typeof v === 'string') {
      out.push(v);
      size += v.length;
    } else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x, depth + 1);
      }
  };
  walk(value, 0);
  return out.join('\n').slice(0, cap);
}

/** NFKC-folded, invisible characters removed, whitespace collapsed, lower case. */
export function fold(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').toLowerCase();
}

/** A word that mixes Latin with a look-alike script ("pаypal" with a Cyrillic а). */
export function hasMixedScriptWord(text: string): boolean {
  for (const word of text.normalize('NFKC').split(/[^\p{L}\p{M}]+/u)) {
    if (word.length > 1 && LATIN.test(word) && CONFUSABLE_SCRIPT.test(word)) return true;
  }
  return false;
}

/* ---- injection ------------------------------------------------------------- */

/**
 * Phrases that address an AI, its reviewer or its permission system instead
 * of the task. Matched on folded text.
 */
const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b.{0,30}\b(instruction|instructions|rules|guidelines|prompt|policy|policies)\b/,
  /\bthis (action|command|call|request|tool call|change|operation|file|script)? ?(is|has been) (safe|harmless|approved|pre-?approved|authori[sz]ed|whitelisted|allow-?listed|verified)\b/,
  /\b(auto-?approve|pre-?approved|already approved|approve (this|it|automatically|without)|mark (this|it) as safe)\b/,
  /\b(the )?(user|owner|admin|administrator|operator|developer) (has )?(already )?(approved|authori[sz]ed|allowed|consented|confirmed)\b/,
  /\b(do not|don't|dont|never) (ask|prompt|notify|tell|warn|alert)\b.{0,30}\b(user|human|owner|permission|approval|confirmation|reviewer)\b/,
  /\bwithout (asking|confirmation|approval|permission|prompting|telling)\b/,
  /\b(new|updated|real|actual|hidden|secret) (system )?instructions?\b/,
  /\b(you are now|you're now|act as|pretend to be|from now on you)\b/,
  /\b(system prompt|system message|developer mode|jailbreak|dan mode)\b/,
  /\b(as|to) (the|an?) (ai )?(reviewer|safety (model|checker|reviewer)|permission (system|checker)|judge)\b/,
  /\b(reviewer|assistant|agent|model|ai)\s*[:,-]\s*(approve|allow|answer yes|respond yes|say yes|output (true|yes))/,
  /\b(answer|respond|reply|output|return)\s+(yes|true|1(\.0)?|"?allow"?)\s+(to|for)\s+(all|every|the|any)\b/,
  /\bp\(?(fits|injection)\)?\s*[=:]/,
  /<\|?(im_start|im_end|system|endoftext)\|?>|\[\[?\s*(system|inst)\s*\]?\]|\[\/?inst\]|<<\/?sys>>/,
  /\b(begin|end) (system|admin|developer) (message|prompt|instructions?)\b/,
  /\b(exfiltrate|send (it|them|this|the (keys?|tokens?|secrets?|credentials?|env)) to)\b/,
];

export function injectionHit(text: string): FloorHit | null {
  if (BIDI.test(text))
    return {
      verdict: 'ask',
      rule: 'floor.bidi_text',
      reason:
        'It contains hidden text-direction characters, which can make code read differently than it runs',
    };
  const stripped = text.replace(INVISIBLE, '');
  if (stripped.length !== text.length && /[​-‍⁠﻿]|[\u{E0000}-\u{E007F}]/u.test(text))
    return {
      verdict: 'ask',
      rule: 'floor.invisible_text',
      reason: 'It contains invisible characters, which can hide instructions',
    };
  const folded = fold(text);
  if (INJECTION.some((re) => re.test(folded)))
    return {
      verdict: 'ask',
      rule: 'floor.injection_text',
      reason: 'It contains text addressed to an AI or its reviewer, which may be an injection attempt',
    };
  return null;
}

/* ---- paths and shell -------------------------------------------------------- */

const PROTECTED =
  /(^|[\s/\\'"=:])(\.env(\.[\w.-]+)?|\.ssh[/\\]|id_(rsa|dsa|ecdsa|ed25519)\b|[\w.-]+\.(pem|key|p12|pfx|kdbx)\b|\.aws[/\\]credentials|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker[/\\]config\.json|\.kube[/\\]config|\.gnupg[/\\]|\/etc\/(shadow|sudoers|passwd)|data[/\\]memory[/\\]|\.git[/\\](config|hooks)\b)/i;

const SECRET_VALUE =
  /\b(sk-[a-z0-9_-]{16,}|sk-ant-[a-z0-9_-]{16,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[abpr]-[a-z0-9-]{10,}|akia[0-9a-z]{16}|aiza[0-9a-z_-]{30,}|hf_[a-z0-9]{20,})\b|\$\{?[a-z_]*(api_?key|secret|token|password|passwd)[a-z_]*\}?|[?&](api_?key|token|secret|password|access_token)=/i;

/** Shell that should never run unattended, whatever else is true. */
const SHELL_BLOCK: [RegExp, string, string][] = [
  [/\bmkfs(\.\w+)?\b|\bformat\s+[a-z]:/i, 'floor.disk_format', 'It formats a disk'],
  [/\bdd\b[^|;&]*\bof=\/dev\//i, 'floor.disk_write', 'It writes straight to a device'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, 'floor.fork_bomb', 'It is a fork bomb'],
  [/>\s*\/dev\/(sd|nvme|hd|disk)/i, 'floor.disk_write', 'It writes straight to a device'],
  [
    /\b(shutdown|reboot|halt|poweroff)\b|\bstop-computer\b|\brestart-computer\b/i,
    'floor.power',
    'It shuts the machine down',
  ],
  [/\bchmod\s+(-r\s+)?[0-7]*777\s+\/(\s|$)/i, 'floor.chmod_root', 'It opens up the whole filesystem'],
];

/** Shell that a person should see first. */
const SHELL_ASK: [RegExp, string, string][] = [
  [/(^|[\s;|&(])(sudo|su|doas|runas)\s/i, 'floor.elevation', 'It asks for administrator rights'],
  [
    /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^;&]*\|\s*(sh|bash|zsh|fish|python\d?|node|perl|ruby|iex|invoke-expression|pwsh|powershell)\b/i,
    'floor.pipe_to_shell',
    'It runs a script straight from the internet',
  ],
  [
    /\bbase64\s+(-d|--decode)\b[^;&]*\|\s*(sh|bash|zsh|python\d?|node)\b/i,
    'floor.encoded_exec',
    'It runs encoded commands',
  ],
  [
    /\b(powershell|pwsh)(\.exe)?\b[^;&]*\s-(e|ec|enc|encodedcommand)\s/i,
    'floor.encoded_exec',
    'It runs encoded commands',
  ],
  [/\b(iex|invoke-expression)\b|(^|[\s;|&])eval\s/i, 'floor.eval', 'It evaluates text as code'],
  [
    /\bgit\s+push\b[^;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\w)/i,
    'floor.force_push',
    'It force-pushes and can overwrite history',
  ],
  [
    /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)/i,
    'floor.discard_work',
    'It throws away uncommitted work',
  ],
  [
    /\b(crontab|systemctl|launchctl|schtasks|reg\s+add|setx)\b/i,
    'floor.persistence',
    'It changes what runs on this machine later',
  ],
  [/\b(history\s+-c|unset\s+histfile|clear-history)\b/i, 'floor.cover_tracks', 'It clears the shell history'],
  [/\b(nc|ncat|netcat)\b[^;&]*\s-(e|c)\s|\/dev\/tcp\//i, 'floor.reverse_shell', 'It opens a remote shell'],
  [
    /\b(env|printenv|set)\b\s*(\||>)|\bcat\b[^;&|]*\.env\b[^;&]*\|/i,
    'floor.env_dump',
    'It reads environment secrets and passes them on',
  ],
  [
    /\bchmod\s+(\+s|[0-7]*[4-7][0-7]{3})\b|\bchown\s+root\b/i,
    'floor.permissions',
    'It changes who can run or own files',
  ],
  [
    /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
    'floor.publish',
    'It publishes a package',
  ],
];

/** Recursive deletes: a whole tree in one go. */
const RECURSIVE_DELETE =
  /(^|[\s;|&(])(rm\s+(-[a-z]*r[a-z]*|-[a-z]*\s+-r|--recursive)\b|rmdir\s+\/s\b|rd\s+\/s\b|del\s+\/s\b|remove-item\b[^;&|]*-recurse\b|find\b[^;&|]*\s-delete\b|shutil\.rmtree|rimraf\b)/i;
/** …aimed at somewhere it must never reach. */
const CATASTROPHIC_TARGET =
  /(\s|^|=)(\/|\/\*|~|~\/|~\/\*|\$home|\$\{home\}|%userprofile%|[a-z]:\\?|[a-z]:\\\*|\*|\.\.?\/?|\/(usr|etc|var|bin|boot|lib|opt|home|users|system|windows)\/?)(\s|$|;|&|\|)/i;

const READ_ACTIONS =
  /^(fs\.(read|list)|knowledge\.search|notebooks\.read|memory\.read|git\.(status|diff|log|branches)|github\.(pr_list|pr_view|runs_list|run_logs))$/;

/**
 * A web address that carries a lot of text in its query or fragment. A GET
 * is the quiet way data leaves: a source that says "open this link with the
 * notebook's notes appended" needs no write and no key. Ordinary links (docs,
 * search results) carry a few short parameters.
 */
const URL_PAYLOAD_CHARS = 200;
export function urlPayload(target: string): boolean {
  let tail: string;
  try {
    const u = new URL(target);
    tail = `${u.search}${u.hash}`;
  } catch {
    return false;
  }
  try {
    tail = decodeURIComponent(tail.replace(/\+/g, ' '));
  } catch {
    /* malformed escapes: measure it as it is */
  }
  return tail.length > URL_PAYLOAD_CHARS;
}

const rank = (h: FloorHit) => (h.verdict === 'block' ? 2 : 1);
const strictest = (hits: (FloorHit | null)[]) =>
  hits.filter((h): h is FloorHit => !!h).sort((a, b) => rank(b) - rank(a))[0] ?? null;

function shellHits(cmd: string): FloorHit | null {
  const hits: (FloorHit | null)[] = [];
  const folded = cmd.normalize('NFKC').replace(INVISIBLE, '');
  for (const [re, rule, reason] of SHELL_BLOCK)
    if (re.test(folded)) hits.push({ verdict: 'block', rule, reason });
  if (RECURSIVE_DELETE.test(folded))
    hits.push(
      CATASTROPHIC_TARGET.test(` ${folded} `)
        ? {
            verdict: 'block',
            rule: 'floor.recursive_delete_root',
            reason: 'It deletes a whole tree at the root, your home folder or everything',
          }
        : {
            verdict: 'ask',
            rule: 'floor.recursive_delete',
            reason: 'It deletes a folder and everything in it',
          },
    );
  for (const [re, rule, reason] of SHELL_ASK)
    if (re.test(folded)) hits.push({ verdict: 'ask', rule, reason });
  return strictest(hits);
}

/* ---- the floors --------------------------------------------------------------- */

export interface FloorInput {
  call: AutoCall;
  /** The effective scope; its checks are floors too. */
  scope?: EffectiveScope | null;
}

/**
 * Every floor, strictest first. null means no floor has anything to say,
 * and the call may go on to the plan, the cache and the reviewer.
 */
export function checkFloors({ call, scope }: FloorInput): FloorHit | null {
  const hits: (FloorHit | null)[] = [];
  if (scope) {
    const s = checkToolCall(scope, { action: call.action, resource: call.resource });
    if (!s.ok) hits.push({ verdict: 'block', rule: `scope.${s.field}`, reason: s.reason });
  }
  const isRead = READ_ACTIONS.test(call.action);
  const kind = scheme(call.resource);
  const target = call.resource.slice(kind.length + 1);

  if (call.outsideRoot && !isRead && kind === 'fs')
    hits.push({
      verdict: 'ask',
      rule: 'floor.outside_root',
      reason: 'It changes a file outside the workspace',
    });
  else if (call.outsideRoot && kind === 'fs')
    hits.push({ verdict: 'ask', rule: 'floor.outside_root_read', reason: 'It reads outside the workspace' });

  if (PROTECTED.test(target))
    hits.push(
      isRead
        ? { verdict: 'ask', rule: 'floor.protected_read', reason: 'It reads a file that may hold secrets' }
        : {
            verdict: 'block',
            rule: 'floor.protected_path',
            reason: 'It touches a file that holds secrets or NVX Ancile internals',
          },
    );
  if (call.action === 'fs.delete' && /\*/.test(target))
    hits.push({ verdict: 'block', rule: 'floor.recursive_delete', reason: 'It deletes by wildcard' });

  const argsText = call.args === undefined ? '' : textOf(call.args);
  if (kind === 'shell') hits.push(shellHits(target));
  else if (call.action === 'shell.exec' || /^(bash|shell|powershell|terminal)$/i.test(call.tool ?? ''))
    hits.push(shellHits(argsText));

  if (SECRET_VALUE.test(target) || (kind !== 'fs' && SECRET_VALUE.test(argsText)))
    hits.push({
      verdict: 'block',
      rule: 'floor.secret_in_call',
      reason: 'It carries what looks like a key or password',
    });

  if (kind === 'http' && urlPayload(target))
    hits.push({
      verdict: 'ask',
      rule: 'floor.data_in_url',
      reason: 'It sends a lot of text out inside a web address',
    });

  const allText = `${target}\n${argsText}`;
  hits.push(injectionHit(allText));
  if (
    hasMixedScriptWord(target) ||
    (kind === 'http' && /(^|[/.@])xn--/i.test(target)) ||
    (kind !== 'fs' && hasMixedScriptWord(argsText))
  )
    hits.push({
      verdict: 'ask',
      rule: 'floor.lookalike_text',
      reason: 'It mixes look-alike letters from different alphabets, a common disguise',
    });
  return strictest(hits);
}
