/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → API keys
 *  Ref      |  docs/configuration.md (API keys)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every key and token NVX Ancile uses, on one page: add,
 *           |  replace or remove each one, and a link to where you get
 *           |  it.
 *  How      |  GET /credentials for the status of each, PUT to check
 *           |  and save a value, DELETE to remove it. A value typed
 *           |  here is sent once and never comes back: rows only know
 *           |  "saved, ends in 4f2a". A value set in the environment
 *           |  wins, and its row is read-only. This is the one place a
 *           |  key is entered: other screens (Admin → Compute's Connect
 *           |  RunPod) open it at their row, ?key=<id>, ready to type.
 * ------------------------------------------------------------------
 */

import type { CredentialId, CredentialList, CredentialStatus, ProviderInfo } from '@nvx/contracts';
import { isPersonalAnthropicKey } from '@nvx/contracts/credentials';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { keys as dataKeys, orDemo } from '../lib/data';
import { loadDemo, useDemoData } from '../lib/demoData';
import { queryClient } from '../lib/query';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { PlanCreditSetting } from './PlanCredit';
import {
  type FriendlyProblem,
  friendlyProblem,
  type KeyNeighbour,
  notOfferedLine,
  type Problem,
  recogniseKey,
  regionLabel,
  safeDocsUrl,
  useProviders,
  withArticle,
} from './providers';

export interface CredentialMeta {
  id: CredentialId;
  name: string;
  /** What it is for, in a sentence. */
  desc: string;
  /** "API key" or "token" or "remote". */
  noun: string;
  placeholder: string;
  getUrl: string;
  getLabel: string;
  /** What stops working when it is removed. */
  removes: string;
}

export const CREDENTIAL_META: CredentialMeta[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    desc: 'Claude models.',
    noun: 'API key',
    placeholder: 'sk-ant-…',
    getUrl: 'https://console.anthropic.com/settings/keys',
    getLabel: 'Get a key',
    removes: 'Claude models stop answering until you add a key again.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'GPT models.',
    noun: 'API key',
    placeholder: 'sk-…',
    getUrl: 'https://platform.openai.com/api-keys',
    getLabel: 'Get a key',
    removes: 'OpenAI models stop answering until you add a key again.',
  },
  {
    id: 'google',
    name: 'Google',
    desc: 'Gemini models.',
    noun: 'API key',
    placeholder: 'AIza…',
    getUrl: 'https://aistudio.google.com/apikey',
    getLabel: 'Get a key',
    removes: 'Gemini models stop answering until you add a key again.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    desc: "Hundreds of models through one key. It also powers Auto mode's reviewer.",
    noun: 'API key',
    placeholder: 'sk-or-…',
    getUrl: 'https://openrouter.ai/settings/keys',
    getLabel: 'Get a key',
    removes: 'OpenRouter models stop answering until you add a key again.',
  },
  {
    id: 'typesafe',
    name: 'TypeSafe (Jev)',
    desc: "Powers Auto mode's reviewer, Jev, which checks actions that are not clearly safe. Your OpenRouter key works too, and is tried first. Only the action, the approved plan and the scope's switches are sent.",
    noun: 'API key',
    placeholder: 'ts_…',
    getUrl: 'https://console.typesafe.ai/settings/keys',
    getLabel: 'Get a key',
    removes: 'Auto mode reviews with OpenRouter, a local model or rules only.',
  },
  ...(
    [
      ['deepseek', 'DeepSeek', 'sk-…', 'https://platform.deepseek.com/api_keys'],
      ['minimax', 'MiniMax', 'Paste the key', 'https://platform.minimax.io'],
      ['mistral', 'Mistral', 'Paste the key', 'https://console.mistral.ai/api-keys'],
      ['moonshot', 'Moonshot (Kimi)', 'sk-…', 'https://platform.kimi.ai/console/api-keys'],
      ['qwen', 'Qwen (Alibaba Model Studio)', 'sk-…', 'https://modelstudio.console.alibabacloud.com'],
      ['xai', 'xAI (Grok)', 'xai-…', 'https://console.x.ai'],
      ['zai', 'Z.ai (GLM)', 'Paste the key', 'https://z.ai/manage-apikey/apikey-list'],
    ] as const
  ).map(
    ([id, name, placeholder, getUrl]): CredentialMeta => ({
      id,
      name,
      desc: `${name} models.`,
      noun: 'API key',
      placeholder,
      getUrl,
      getLabel: 'Get a key',
      removes: `${name} models stop answering until you add a key again.`,
    }),
  ),
  {
    id: 'runpod',
    name: 'RunPod',
    desc: 'Starts and stops GPU nodes in your RunPod account. Needs read and write access to pods.',
    noun: 'API key',
    placeholder: 'rpa_…',
    getUrl: 'https://www.runpod.io/console/user/settings',
    getLabel: 'Get a key',
    removes: 'Admin → Compute stops managing your pods. They keep running, and billing, in RunPod.',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    desc: 'Downloads gated models, such as Llama, onto your GPU nodes. A read token is enough.',
    noun: 'token',
    placeholder: 'hf_…',
    getUrl: 'https://huggingface.co/settings/tokens',
    getLabel: 'Get a token',
    removes: 'Gated models can no longer be downloaded onto new nodes.',
  },
  {
    id: 'github',
    name: 'GitHub',
    desc: 'Pull requests and Actions runs in Repositories, when the gh command is not signed in.',
    noun: 'token',
    placeholder: 'github_pat_…',
    getUrl: 'https://github.com/settings/personal-access-tokens/new',
    getLabel: 'Get a token',
    removes: 'Repositories use the gh command if it is signed in, or show no GitHub details.',
  },
  {
    id: 'memory_remote',
    name: 'Memory backup',
    desc: 'A private git repository your memory is pushed to every hour.',
    noun: 'remote',
    placeholder: 'git@github.com:you/memory.git',
    getUrl: 'https://github.com/new',
    getLabel: 'Create a private repository',
    removes: 'Memory stops being backed up. What was pushed already stays in that repository.',
  },
];

/** The model providers that come first, in this order; every other one Core lists follows, A to Z. */
const FIRST_PROVIDERS: CredentialId[] = ['anthropic', 'openai', 'google', 'openrouter'];
/** Shown until Core has listed its providers. */
const MORE_PROVIDERS: CredentialId[] = ['deepseek', 'minimax', 'mistral', 'moonshot', 'qwen', 'xai', 'zai'];

const GROUPS: { title: string; lede: string; ids: CredentialId[] }[] = [
  {
    title: 'Models',
    lede: 'Each key is checked with one short request before it is saved.',
    ids: ['anthropic', 'openai', 'google', 'openrouter'],
  },
  { title: 'Compute', lede: 'Your own GPU nodes.', ids: ['runpod', 'huggingface'] },
  {
    title: 'Auto mode review',
    lede: 'Jev, the independent reviewer behind Auto mode. A TypeSafe key or your OpenRouter key powers it.',
    ids: ['typesafe'],
  },
  {
    title: 'Repositories and backup',
    lede: 'GitHub and where memory is copied to.',
    ids: ['github', 'memory_remote'],
  },
];

const KEY = ['credentials'] as const;

export function useCredentials() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      orDemo<CredentialStatus[]>(
        () => api.get<CredentialList>('/credentials').then((r) => r.items),
        () => loadDemo().then((m) => m.credentials),
      ),
    staleTime: 30_000,
  });
}

/** "Saved · ends in 4f2a", "Set in the environment", "Not set". */
export function statusText(s: Pick<CredentialStatus, 'set' | 'source' | 'last4'> | undefined): string {
  if (!s?.set) return 'Not set';
  const tail = s.last4 ? ` · ends in ${s.last4}` : '';
  return s.source === 'environment' ? `Set in the environment${tail}` : `Saved${tail}`;
}

const refresh = (id: CredentialId) => {
  void queryClient.invalidateQueries({ queryKey: KEY });
  void queryClient.invalidateQueries({ queryKey: dataKeys.models });
  void queryClient.invalidateQueries({ queryKey: ['flows', 'models'] });
  if (id === 'runpod') void queryClient.invalidateQueries({ queryKey: ['compute'] });
};

const problemOf = (e: unknown): Problem =>
  e instanceof ApiCallError
    ? {
        title: e.body.error.title,
        hint: e.body.error.hint,
        code: e.body.error.code,
        ...(e.body.error.detail && { detail: e.body.error.detail }),
      }
    : { title: 'NVX Ancile did not answer', hint: 'Check that it is running, then try again.' };

/** "wrkspc_01Ab…9xYz": enough to recognise a workspace without a wall of characters. */
export const shortWorkspace = (id: string) => (id.length > 18 ? `${id.slice(0, 11)}…${id.slice(-4)}` : id);

/** A key pasted into a row, handed to another row: its id and the text, once. */
interface Moved {
  id: CredentialId;
  value: string;
}

export function CredentialRow({
  meta,
  status,
  info,
  neighbours = [],
  focused = false,
  incoming,
  onMove,
  onTaken,
  lastCheck,
}: {
  meta: CredentialMeta;
  status: CredentialStatus | undefined;
  /** What Core says about this provider (regions, how a key looks, where to get one). */
  info?: ProviderInfo | undefined;
  /** The other model-provider rows a pasted key could be moved to. */
  neighbours?: KeyNeighbour[];
  /** Opened from another screen for this key: brought into view, ready to type. */
  focused?: boolean;
  /** A key another row recognised as this one's. */
  incoming?: Moved | null;
  onMove?: (to: CredentialId, value: string) => void;
  onTaken?: () => void;
  /** Demo mode: how a recent check of this key went. */
  lastCheck?: FriendlyProblem | undefined;
}) {
  const [mode, setMode] = useState<'idle' | 'edit' | 'confirm'>('idle');
  const [value, setValue] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [region, setRegion] = useState('');
  const [reveal, setReveal] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const keyHintId = useId();
  const workspaceId = useId();
  const workspaceHintId = useId();
  const regionId = useId();
  const regionHintId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // Closing the field or the remove question hands focus back to the row's button (D9).
  const lastMode = useRef(mode);
  useEffect(() => {
    const was = lastMode.current;
    lastMode.current = mode;
    if (mode === 'idle' && was !== 'idle')
      rowRef.current?.querySelector<HTMLElement>('.setting__control button, button.btn')?.focus();
  }, [mode]);
  // Once its status is known: a key not set yet that can be typed opens its field.
  useEffect(() => {
    if (!focused || !status || opened.current) return;
    opened.current = true;
    rowRef.current?.scrollIntoView?.({ block: 'center' });
    // A key already set is shown, not asked for again: Change is one click away.
    if (!status.set && status.source !== 'environment' && status.available) setMode('edit');
  }, [focused, status]);
  // A key another row recognised as this one's lands here, ready to check and save.
  useEffect(() => {
    if (!incoming || incoming.id !== meta.id) return;
    setValue(incoming.value);
    setMode('edit');
    onTaken?.();
  }, [incoming, meta.id, onTaken]);

  const regions = info?.regions ?? null;
  // The region in force: what you picked, else the one saved with the key, else the provider's default.
  const chosenRegion = regions
    ? region || status?.region || info?.default_region || regions[0]?.id || ''
    : '';

  const save = useMutation({
    mutationFn: (v: { value: string; workspace_id?: string; region?: string }) =>
      api.put<CredentialStatus>(`/credentials/${meta.id}`, v),
    onSuccess: (s) => {
      setValue('');
      setWorkspace('');
      setRegion('');
      setReveal(false);
      setMode('idle');
      queryClient.setQueryData<CredentialStatus[]>(KEY, (all) => all?.map((x) => (x.id === s.id ? s : x)));
      refresh(meta.id);
      notify(
        meta.id === 'runpod'
          ? {
              level: 'success',
              title: 'RunPod connected',
              body: 'Admin → Compute manages your pods now. The key is encrypted on this computer.',
            }
          : {
              level: 'success',
              title: `${meta.name} ${meta.noun} saved`,
              body: `It is encrypted on this computer.${notOfferedLine(s.not_offered) ? ` ${notOfferedLine(s.not_offered)}` : ''}`,
            },
      );
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del<CredentialStatus>(`/credentials/${meta.id}`),
    onSuccess: () => {
      setMode('idle');
      refresh(meta.id);
      notify({ level: 'info', title: `${meta.name} ${meta.noun} removed` });
    },
    onError: (e) => {
      const p = problemOf(e);
      notify({ level: 'error', title: p.title, body: p.hint });
    },
  });

  // A saved key moved to another region: Core tests the key it already holds there (the key never comes back).
  const moveRegion = useMutation({
    mutationFn: (to: string) =>
      api.post('/setup/providers/test', { provider: meta.id, use_saved: true, region: to, save: true }),
    onSuccess: (_r, to) => {
      refresh(meta.id);
      notify({
        level: 'success',
        title: `${meta.name} now uses ${regionLabel(info, to)}`,
        body: 'The saved key works there.',
      });
    },
  });

  const fromEnv = status?.source === 'environment';
  const unavailable = status && !status.available;
  const failed = save.error ?? moveRegion.error;
  const raw = failed ? problemOf(failed) : null;
  // After a failed region move, "try another region" means other than the one just tried.
  const triedRegion = moveRegion.error ? (moveRegion.variables ?? chosenRegion) : chosenRegion;
  const problem = raw ? friendlyProblem(raw, { name: meta.name, regions, region: triedRegion }) : null;
  // A personal Anthropic key bills a workspace you name: its field appears as soon as one is pasted.
  const needsWorkspace =
    meta.id === 'anthropic' &&
    (isPersonalAnthropicKey(value) || problem?.code === 'provider.workspace_needed');
  const suggestion = onMove ? recogniseKey(value, meta.id, neighbours) : null;
  const cancel = () => {
    setMode('idle');
    setValue('');
    setWorkspace('');
    setRegion('');
    save.reset();
  };
  const submit = (inRegion: string) => {
    if (!value.trim() || (needsWorkspace && !workspace.trim())) return;
    save.mutate({
      value: value.trim(),
      ...(needsWorkspace && { workspace_id: workspace.trim() }),
      ...(regions && inRegion && { region: inRegion }),
    });
  };
  const checking =
    meta.id === 'runpod' ? 'Checking with RunPod…' : meta.id === 'memory_remote' ? 'Saving…' : 'Checking…';
  const getUrl = safeDocsUrl(info?.docs_url) ?? meta.getUrl;
  const keyHint = info?.needs_key !== false && info?.key_hint ? `Your key ${info.key_hint}.` : null;

  return (
    <div
      ref={rowRef}
      id={`credential-${meta.id}`}
      className="setting credential"
      data-stack={mode !== 'idle' || undefined}
      data-set={status?.set || undefined}
      data-focused={focused || undefined}
    >
      <div className="setting__words">
        <div className="setting__label">
          <span>{meta.name}</span>
          <span className="credential__status" data-source={status?.source ?? 'none'}>
            {fromEnv ? <Icon name="lock" size={11} /> : status?.set ? <Icon name="check" size={11} /> : null}
            {status ? statusText(status) : 'Checking…'}
          </span>
        </div>
        <p className="setting__desc">
          {meta.desc}{' '}
          <a className="credential__get" href={getUrl} target="_blank" rel="noreferrer">
            {meta.getLabel}
            <Icon name="ext" size={10} />
          </a>
        </p>
        {fromEnv ? (
          <p className="setting__desc">
            Read-only here: it comes from <code>{status?.env_var}</code>. Change or remove it where NVX Ancile
            is started, then restart it.
          </p>
        ) : null}
        {unavailable ? <p className="setting__desc">{status?.unavailable_reason}</p> : null}
        {status?.set && status.workspace_id ? (
          <p className="setting__desc">
            Personal key, billing workspace{' '}
            <code title={status.workspace_id}>{shortWorkspace(status.workspace_id)}</code>.
          </p>
        ) : null}
        {meta.id === 'anthropic' && status?.set ? <PlanCreditSetting saved={status.plan_credit} /> : null}
        {status?.set && regions ? (
          <div className="setting__desc credential__saved-region">
            <label htmlFor={`${regionId}-saved`}>Region</label>{' '}
            <select
              id={`${regionId}-saved`}
              className="input input--sm"
              value={status.region ?? info?.default_region ?? ''}
              disabled={moveRegion.isPending || fromEnv}
              onChange={(e) => {
                save.reset();
                moveRegion.reset();
                moveRegion.mutate(e.target.value);
              }}
            >
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            {moveRegion.isPending ? <span aria-live="polite"> Testing the key there</span> : null}
            {status.region_env_var ? (
              <>
                {' '}
                (<code>{status.region_env_var}</code> overrides it)
              </>
            ) : null}
          </div>
        ) : null}
        {moveRegion.error && problem ? (
          <div className="credential__problem" role="alert">
            <p>
              <strong>{problem.title}.</strong> {problem.hint}
            </p>
            {problem.tryRegions.length ? (
              <p>
                {problem.tryRegions.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => moveRegion.mutate(r.id)}
                  >
                    Try {r.label}
                  </button>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}
        {lastCheck && mode === 'idle' && !status?.set ? (
          <div className="credential__problem">
            <p>
              <strong>{lastCheck.title}.</strong> {lastCheck.hint}
            </p>
            {lastCheck.detail ? (
              <p className="credential__said">
                {meta.name} said: <q>{lastCheck.detail}</q>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === 'idle' && !fromEnv ? (
        <div className="setting__control">
          {status?.set ? (
            <button type="button" className="link-btn link-btn--quiet" onClick={() => setMode('confirm')}>
              Remove
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!status || unavailable}
            onClick={() => setMode('edit')}
          >
            {status?.set ? 'Replace' : `Add ${meta.noun}`}
          </button>
        </div>
      ) : null}

      {mode === 'edit' ? (
        <form
          className="credential__edit"
          onSubmit={(e) => {
            e.preventDefault();
            submit(chosenRegion);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {meta.name} {meta.noun}
          </label>
          <div className="credential__field">
            <input
              id={inputId}
              className="input input--mono"
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={meta.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  cancel();
                }
              }}
              aria-invalid={problem ? true : undefined}
              aria-describedby={keyHint ? `${hintId} ${keyHintId}` : hintId}
              // biome-ignore lint/a11y/noAutofocus: the field appears because you asked to type into it
              autoFocus
            />
            <button
              type="button"
              className="credential__reveal link-btn link-btn--quiet"
              aria-pressed={reveal}
              onClick={() => setReveal((r) => !r)}
            >
              <Icon name="eye" size={13} />
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>
          <p id={hintId} className="setting__desc">
            {meta.id === 'memory_remote'
              ? 'Any address git can push to. It is kept encrypted, as it may hold a token.'
              : `Checked with ${meta.name} before it is saved, then kept encrypted on this computer. It is never shown again.`}
          </p>
          {keyHint ? (
            <p id={keyHintId} className="setting__desc credential__keyhint">
              {keyHint}
            </p>
          ) : null}
          {suggestion && onMove ? (
            <p className="credential__suggest" role="status">
              This looks like {withArticle(suggestion.name)} key.{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  onMove(suggestion.id as CredentialId, value.trim());
                  cancel();
                }}
              >
                Move it there
              </button>
            </p>
          ) : null}
          {regions ? (
            <div className="credential__region">
              <label htmlFor={regionId} className="setting__label">
                Region
              </label>
              <select
                id={regionId}
                className="input"
                value={chosenRegion}
                onChange={(e) => setRegion(e.target.value)}
                aria-describedby={regionHintId}
              >
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <p id={regionHintId} className="setting__desc">
                A {meta.name} key only works in the region it was made in.
              </p>
            </div>
          ) : null}
          {needsWorkspace ? (
            <div className="credential__workspace">
              <label htmlFor={workspaceId} className="setting__label">
                Workspace ID
              </label>
              <input
                id={workspaceId}
                className="input input--mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="wrkspc_…"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    cancel();
                  }
                }}
                aria-describedby={workspaceHintId}
              />
              <p id={workspaceHintId} className="setting__desc">
                This is a personal key, so Anthropic needs to know which workspace to bill. In the Claude
                Console, open Settings → Workspaces, open the workspace and copy its ID.
              </p>
            </div>
          ) : null}
          {problem ? (
            <div className="credential__problem" role="alert">
              <p>
                <strong>{problem.title}.</strong> {problem.hint}
              </p>
              {problem.detail ? (
                <p className="credential__said">
                  {meta.name} said: <q>{problem.detail}</q>
                </p>
              ) : null}
              {problem.tryRegions.length ? (
                <div className="credential__actions credential__actions--start">
                  {problem.tryRegions.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={save.isPending}
                      onClick={() => {
                        setRegion(r.id);
                        submit(r.id);
                      }}
                    >
                      Try {r.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="credential__actions">
            <button type="button" className="btn btn--quiet btn--sm" onClick={cancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={!value.trim() || (needsWorkspace && !workspace.trim()) || save.isPending}
            >
              {save.isPending ? checking : meta.id === 'memory_remote' ? 'Save remote' : `Check and save`}
            </button>
          </div>
        </form>
      ) : null}

      {mode === 'confirm' ? (
        <div
          className="credential__confirm"
          role="alertdialog"
          aria-label={`Remove the ${meta.name} ${meta.noun}?`}
        >
          <p>
            <strong>
              Remove the {meta.name} {meta.noun}?
            </strong>{' '}
            {meta.removes}
          </p>
          <div className="credential__actions">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setMode('idle')}>
              Keep it
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Removing…' : `Remove ${meta.noun}`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A row's meta for a provider Core lists that this build has no words for yet. */
const metaFor = (info: ProviderInfo): CredentialMeta | null => {
  const known = CREDENTIAL_META.find((m) => m.id === info.credential_id);
  if (known) return known;
  if (!info.credential_id) return null;
  return {
    id: info.credential_id,
    name: info.name,
    desc: `${info.name} models.`,
    noun: 'API key',
    placeholder: 'Paste the key',
    getUrl: safeDocsUrl(info.docs_url) ?? '#',
    getLabel: 'Get a key',
    removes: `${info.name} models stop answering until you add a key again.`,
  };
};

export function ApiKeysGroup() {
  const q = useContext(SearchContext);
  const focus = (useSearch({ strict: false }) as { key?: string }).key;
  const list = useCredentials();
  const providers = useProviders();
  const isDemo = useUi((s) => s.demo);
  const demo = useDemoData(isDemo);
  const [moved, setMoved] = useState<Moved | null>(null);
  const taken = useCallback(() => setMoved(null), []);
  const byId = new Map((list.data ?? []).map((s) => [s.id, s]));
  const infoById = new Map<string, ProviderInfo>(
    (providers.data ?? []).filter((p) => p.credential_id).map((p) => [p.id, p]),
  );

  // Models: the four most people use, then every other provider Core lists, A to Z. Until Core has
  // listed them, the ones this build knows stand in, without regions.
  const more: CredentialMeta[] = (
    infoById.size
      ? [...infoById.values()]
          .filter((p) => !FIRST_PROVIDERS.includes(p.credential_id as CredentialId))
          .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'))
          .map(metaFor)
      : CREDENTIAL_META.filter((m) => MORE_PROVIDERS.includes(m.id)).sort((a, b) =>
          a.name.localeCompare(b.name, 'en-GB'),
        )
  ).filter((m): m is CredentialMeta => !!m);
  // Rows a pasted key could be moved to: model providers that can take a typed key.
  const neighbours: KeyNeighbour[] = [
    ...CREDENTIAL_META.filter((m) => FIRST_PROVIDERS.includes(m.id)),
    ...more,
  ]
    .filter((m) => byId.get(m.id) && byId.get(m.id)?.source !== 'environment' && byId.get(m.id)?.available)
    .map((m) => ({ id: m.id, name: m.name }));

  const blocks = [
    ...GROUPS.map((g) => ({
      title: g.title,
      lede: g.lede,
      rows: CREDENTIAL_META.filter((m) => g.ids.includes(m.id)),
    })),
  ];
  blocks.splice(1, 0, {
    title: 'More model providers',
    lede: 'Each key works only with the provider that made it, and is checked with one short request before it is saved.',
    rows: more,
  });

  return (
    <>
      {list.isError ? (
        <p className="credential__problem" role="alert">
          <strong>{problemOf(list.error).title}.</strong> {problemOf(list.error).hint}
        </p>
      ) : null}
      {blocks.map((g) => {
        const rows = g.rows.filter((m) =>
          matches(q, m.name, m.desc, m.noun, 'api key token secret credential'),
        );
        if (!rows.length) return null;
        return (
          <Block key={g.title} title={g.title} lede={g.lede}>
            {rows.map((m) => {
              const modelRow = FIRST_PROVIDERS.includes(m.id) || more.some((x) => x.id === m.id);
              const demoProblem = demo ? demo.providerProblems[m.id] : undefined;
              return (
                <CredentialRow
                  key={m.id}
                  meta={m}
                  status={byId.get(m.id)}
                  info={infoById.get(m.id)}
                  focused={focus === m.id}
                  {...(modelRow && {
                    neighbours: neighbours.filter((n) => n.id !== m.id),
                    onMove: (to: CredentialId, value: string) => setMoved({ id: to, value }),
                  })}
                  incoming={moved}
                  onTaken={taken}
                  lastCheck={demoProblem ? friendlyProblem(demoProblem, { name: m.name }) : undefined}
                />
              );
            })}
          </Block>
        );
      })}
    </>
  );
}
