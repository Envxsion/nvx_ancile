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
 *           |  wins, and its row is read-only.
 * ------------------------------------------------------------------
 */

import type { CredentialId, CredentialList, CredentialStatus } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext, useId, useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { keys as dataKeys } from '../lib/data';
import { queryClient } from '../lib/query';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';

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
    desc: 'Hundreds of models through one key.',
    noun: 'API key',
    placeholder: 'sk-or-…',
    getUrl: 'https://openrouter.ai/settings/keys',
    getLabel: 'Get a key',
    removes: 'OpenRouter models stop answering until you add a key again.',
  },
  {
    id: 'runpod',
    name: 'RunPod',
    desc: 'Starts and stops GPU nodes in your RunPod account. Needs read and write access to pods.',
    noun: 'API key',
    placeholder: 'rpa_…',
    getUrl: 'https://www.runpod.io/console/user/settings',
    getLabel: 'Get a key',
    removes: 'Admin → Compute goes back to sample nodes. Your pods keep running in RunPod.',
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
    desc: 'A private git repository your memory is pushed to every night.',
    noun: 'remote',
    placeholder: 'git@github.com:you/memory.git',
    getUrl: 'https://github.com/new',
    getLabel: 'Create a private repository',
    removes: 'Memory stops being backed up. What was pushed already stays in that repository.',
  },
];

const GROUPS: { title: string; lede: string; ids: CredentialId[] }[] = [
  {
    title: 'Models',
    lede: 'Each key is checked with one short request before it is saved.',
    ids: ['anthropic', 'openai', 'google', 'openrouter'],
  },
  { title: 'Compute', lede: 'Your own GPU nodes.', ids: ['runpod', 'huggingface'] },
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
    queryFn: () => api.get<CredentialList>('/credentials').then((r) => r.items),
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

const problemOf = (e: unknown) =>
  e instanceof ApiCallError
    ? { title: e.body.error.title, hint: e.body.error.hint }
    : { title: 'NVX Ancile did not answer', hint: 'Check that it is running, then try again.' };

function CredentialRow({ meta, status }: { meta: CredentialMeta; status: CredentialStatus | undefined }) {
  const [mode, setMode] = useState<'idle' | 'edit' | 'confirm'>('idle');
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const inputId = useId();
  const hintId = useId();

  const save = useMutation({
    mutationFn: (v: string) => api.put<CredentialStatus>(`/credentials/${meta.id}`, { value: v }),
    onSuccess: (s) => {
      setValue('');
      setReveal(false);
      setMode('idle');
      queryClient.setQueryData<CredentialStatus[]>(KEY, (all) => all?.map((x) => (x.id === s.id ? s : x)));
      refresh(meta.id);
      notify({
        level: 'success',
        title: `${meta.name} ${meta.noun} saved`,
        body: 'It is encrypted on this computer.',
      });
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

  const fromEnv = status?.source === 'environment';
  const unavailable = status && !status.available;
  const problem = save.error ? problemOf(save.error) : null;
  const checking =
    meta.id === 'runpod' ? 'Checking with RunPod…' : meta.id === 'memory_remote' ? 'Saving…' : 'Checking…';

  return (
    <div
      className="setting credential"
      data-stack={mode !== 'idle' || undefined}
      data-set={status?.set || undefined}
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
          <a className="credential__get" href={meta.getUrl} target="_blank" rel="noreferrer">
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
            if (value.trim()) save.mutate(value.trim());
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
                  setMode('idle');
                  setValue('');
                  save.reset();
                }
              }}
              aria-invalid={problem ? true : undefined}
              aria-describedby={hintId}
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
          {problem ? (
            <p className="credential__problem" role="alert">
              <strong>{problem.title}.</strong> {problem.hint}
            </p>
          ) : null}
          <div className="credential__actions">
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                setMode('idle');
                setValue('');
                save.reset();
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={!value.trim() || save.isPending}
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

export function ApiKeysGroup() {
  const q = useContext(SearchContext);
  const list = useCredentials();
  const byId = new Map((list.data ?? []).map((s) => [s.id, s]));
  return (
    <>
      {list.isError ? (
        <p className="credential__problem" role="alert">
          <strong>{problemOf(list.error).title}.</strong> {problemOf(list.error).hint}
        </p>
      ) : null}
      {GROUPS.map((g) => {
        const rows = CREDENTIAL_META.filter(
          (m) =>
            g.ids.includes(m.id) && matches(q, m.name, m.desc, m.noun, 'api key token secret credential'),
        );
        if (!rows.length) return null;
        return (
          <Block key={g.title} title={g.title} lede={g.lede}>
            {rows.map((m) => (
              <CredentialRow key={m.id} meta={m} status={byId.get(m.id)} />
            ))}
          </Block>
        );
      })}
    </>
  );
}
