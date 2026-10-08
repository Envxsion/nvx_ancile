/**
 * ------------------------------------------------------------------
 *  Title    |  First run
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Short steps from nothing to a first answer, with no file
 *           |  to edit (DESIGN.md §13.5).
 *  How      |  Steps are a real sequence, so they are numbered. "Test"
 *           |  sends one real request through Core with the key; only a
 *           |  key that works is stored (encrypted). Finishing saves the
 *           |  permission preset and memory preference, then opens a
 *           |  first thread with the composer ready.
 *  Note     |  With no key at all, the offline test model lets you try
 *           |  everything; the screen says plainly what it is.
 *           |  TODO(phase-3): a first-notebook step with real upload.
 *           |  TODO(phase-5): the Controller check.
 * ------------------------------------------------------------------
 */

import { AncileMark } from '@nvx/aperture';
import type { ProviderId, SetupStatus } from '@nvx/contracts';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { keyText as bindingText } from '../keys/registry';
import { ApiCallError, api } from '../lib/api';
import { keys as queryKeys, useSetup } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { ShareStatsCard } from '../telemetry/ShareStats';
import { Icon } from '../ui/Icon';
import { Kbd } from '../ui/primitives';

const STEPS = ['Welcome', 'Models', 'Permissions', 'Memory', 'Shortcuts'] as const;

const PROVIDERS: { id: ProviderId; name: string; placeholder: string }[] = [
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', name: 'Google', placeholder: 'AIza…' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…' },
];

const PRESETS = [
  {
    id: 'careful',
    name: 'Careful',
    body: 'Anything beyond reading asks first, and remembers only for the thread you are in.',
    example: 'Saving a file asks in every new thread.',
  },
  {
    id: 'balanced',
    name: 'Balanced',
    body: 'Reading is free. Writing in your workspace asks once per place. Deleting, sending and spending always ask.',
    example: 'Approve saving to a folder once; it is remembered.',
  },
  {
    id: 'hands_off',
    name: 'Hands-off',
    body: 'Writing inside your workspace just happens. Deleting, sending and spending still always ask.',
    example: 'Drafts save without a prompt; deleting a file still asks.',
  },
] as const;

const CAPTURE = [
  {
    id: 'auto_confident',
    name: 'Learn when it is sure',
    body: 'Clear corrections are saved straight away, with Undo. Anything less certain waits for you in the inbox.',
  },
  { id: 'propose_all', name: 'Ask me every time', body: 'Nothing is remembered until you approve it.' },
  { id: 'off', name: 'Do not learn', body: 'Memory is only what you write yourself.' },
] as const;

type TestState =
  | { state: 'testing' }
  | { state: 'ok'; detail: string }
  | { state: 'failed'; title: string; hint: string };

export function SetupScreen() {
  const status = useSetup();
  const [step, setStep] = useState(0);
  const [keyText, setKeyText] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestState | undefined>>({});
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('balanced');
  const [capture, setCapture] = useState<(typeof CAPTURE)[number]['id']>('auto_confident');
  const [about, setAbout] = useState('');
  const [finishing, setFinishing] = useState(false);
  const navigate = useNavigate();

  // Providers already connected (a key in .env was imported, or setup was run before).
  useEffect(() => {
    const s = status.data;
    if (!s) return;
    setTests((t) => {
      const next = { ...t };
      for (const p of s.providers)
        if (p.configured && !next[p.id]) next[p.id] = { state: 'ok', detail: 'Connected' };
      return next;
    });
    if (s.preset) setPreset(s.preset);
  }, [status.data]);

  const test = async (provider: ProviderId) => {
    setTests((t) => ({ ...t, [provider]: { state: 'testing' } }));
    try {
      const r = await api.post<{ latency_ms: number; enabled: string[] }>('/setup/providers/test', {
        provider,
        ...(keyText[provider] && { key: keyText[provider] }),
      });
      setTests((t) => ({
        ...t,
        [provider]: {
          state: 'ok',
          detail: `Connected in ${r.latency_ms} ms · ${r.enabled.length} ${r.enabled.length === 1 ? 'model' : 'models'} on`,
        },
      }));
      setKeyText((k) => ({ ...k, [provider]: '' }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    } catch (error) {
      const e = error instanceof ApiCallError ? error.body.error : null;
      setTests((t) => ({
        ...t,
        [provider]: {
          state: 'failed',
          title: e?.title ?? 'Core did not answer',
          hint: e?.hint ?? 'Check that NVX Ancile is running (pnpm start), then test again.',
        },
      }));
    }
  };

  const connected = Object.values(tests).some((t) => t?.state === 'ok');
  const offline = status.data?.offline_model ?? false;
  const canNext = step !== 1 || connected || offline;
  const last = step === STEPS.length - 1;

  const finish = async () => {
    setFinishing(true);
    try {
      await api.post<SetupStatus>('/setup/complete', {
        preset,
        memory_capture: capture,
        ...(about.trim() && { about: about.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.setup });
      notify({
        level: 'success',
        title: 'NVX Ancile is ready',
        body: `Press ${bindingText('palette.open')} whenever you need anything.`,
      });
      // Home, not an empty thread: nothing is created until you ask something.
      await navigate({ to: '/' });
    } catch (error) {
      notify({
        level: 'error',
        title: error instanceof ApiCallError ? error.body.error.title : 'Setup could not be saved',
        body:
          error instanceof ApiCallError
            ? error.body.error.hint
            : 'Check that NVX Ancile is running (pnpm start), then try again.',
      });
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="setup">
      <aside className="setup__rail" aria-label="Setup progress">
        <div className="setup__brand">
          <AncileMark size={26} />
          <span className="wordmark">
            NVX <span>Ancile</span>
          </span>
        </div>
        <ol className="setup__steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="setup__num" data-num>
                {i < step ? <Icon name="check" size={11} /> : i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
        <p className="setup__privacy mute">Everything you set here stays on this machine.</p>
      </aside>

      <main className="setup__main">
        <div className="setup__card" key={step}>
          {step === 0 ? (
            <>
              <h1 className="setup__title" data-display>
                Welcome to NVX Ancile
              </h1>
              <p className="setup__lede">
                A private place to think with AI. Your conversations, sources and memory stay on this machine.
                Models are only sent what a question needs, and you can see exactly what that was for every
                answer.
              </p>
              <ul className="setup__points">
                <li>Connect the models you already pay for, or run your own.</li>
                <li>Decide once what the AI may do on its own.</li>
                <li>Add sources and get answers that cite them.</li>
              </ul>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h1 className="setup__title" data-display>
                Connect your models
              </h1>
              <p className="setup__lede">
                Add at least one. A key is tested with one short request, then encrypted on this machine and
                only used to call that provider.
              </p>
              <div className="setup__providers">
                {PROVIDERS.map((p) => {
                  const t = tests[p.id];
                  return (
                    <div key={p.id} className="provider" data-state={t?.state}>
                      <label htmlFor={`key-${p.id}`} className="provider__name">
                        {p.name}
                        <span className="sr-only"> API key</span>
                      </label>
                      <input
                        id={`key-${p.id}`}
                        className="input input--mono"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={
                          t?.state === 'ok' ? 'Connected. Paste a new key to replace it.' : p.placeholder
                        }
                        value={keyText[p.id] ?? ''}
                        onChange={(e) => setKeyText((k) => ({ ...k, [p.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && keyText[p.id]) void test(p.id);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={!keyText[p.id] || t?.state === 'testing'}
                        onClick={() => void test(p.id)}
                        aria-label={`Test ${p.name} key`}
                      >
                        {t?.state === 'testing' ? 'Testing' : 'Test'}
                      </button>
                      {t?.state === 'ok' ? (
                        <p className="provider__note" data-tone="ok">
                          <Icon name="check" size={12} /> {t.detail}
                        </p>
                      ) : null}
                      {t?.state === 'failed' ? (
                        <p className="provider__note" data-tone="fail" role="alert">
                          <strong>{t.title}.</strong> {t.hint}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <div className="provider provider--detected" data-state={tests.ollama?.state}>
                  <span className="provider__name">Ollama</span>
                  <span className="mute">Models running on this computer. No key needed.</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={tests.ollama?.state === 'testing'}
                    onClick={() => void test('ollama')}
                  >
                    {tests.ollama?.state === 'testing' ? 'Looking' : 'Find it'}
                  </button>
                  {tests.ollama?.state === 'ok' ? (
                    <p className="provider__note" data-tone="ok">
                      <Icon name="check" size={12} /> {tests.ollama.detail}
                    </p>
                  ) : null}
                  {tests.ollama?.state === 'failed' ? (
                    <p className="provider__note" data-tone="fail" role="alert">
                      <strong>{tests.ollama.title}.</strong> {tests.ollama.hint}
                    </p>
                  ) : null}
                </div>
              </div>
              {!connected && offline ? (
                <p className="setup__offline">
                  <Icon name="model" size={14} />
                  No key yet? Continue with the offline test model. It can't think, but it streams, calls
                  tools and asks for permission like a real one, so you can try everything. Add a key later in
                  Settings.
                </p>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h1 className="setup__title" data-display>
                What may the AI do without asking?
              </h1>
              <p className="setup__lede">
                You can change this at any time, and every permission you grant is listed in Admin with a
                revoke button.
              </p>
              <RadioGroup.Root
                className="options"
                value={preset}
                onValueChange={(v) => setPreset(v as typeof preset)}
                aria-label="Permission preset"
              >
                {PRESETS.map((p) => (
                  <RadioGroup.Item key={p.id} value={p.id} className="option" aria-label={p.name}>
                    <span className="option__name">
                      {p.name}
                      {p.id === 'balanced' ? <span className="option__rec">Recommended</span> : null}
                    </span>
                    <span className="option__body">{p.body}</span>
                    <span className="option__example mute">{p.example}</span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h1 className="setup__title" data-display>
                How should it learn from you?
              </h1>
              <p className="setup__lede">
                Memory is a set of plain files, versioned with git. You can read, edit or roll back any of it.
              </p>
              <RadioGroup.Root
                className="options"
                value={capture}
                onValueChange={(v) => setCapture(v as typeof capture)}
                aria-label="Memory capture"
              >
                {CAPTURE.map((c) => (
                  <RadioGroup.Item key={c.id} value={c.id} className="option" aria-label={c.name}>
                    <span className="option__name">{c.name}</span>
                    <span className="option__body">{c.body}</span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
              <label className="field">
                <span>Anything it should know from the start? (optional)</span>
                <textarea
                  className="input"
                  rows={3}
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  placeholder="I write in British English. I'm an energy analyst; keep answers short and end with a recommendation."
                />
              </label>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <h1 className="setup__title" data-display>
                Five keys worth knowing
              </h1>
              <ul className="setup__keys">
                <li>
                  <Kbd keys="mod+k" /> Find anything, run any command
                </li>
                <li>
                  <Kbd keys="m" /> Change model, mid-thread
                </li>
                <li>
                  <Kbd keys="i" /> Write a message
                </li>
                <li>
                  <Kbd keys="w" /> See why the AI said what it said
                </li>
                <li>
                  <Kbd keys="?" /> Every other shortcut
                </li>
              </ul>
              <ShareStatsCard place="setup" />
            </>
          ) : null}
        </div>

        <div className="setup__nav">
          {step > 0 ? (
            <button type="button" className="btn btn--ghost" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canNext || finishing}
            title={canNext ? undefined : 'Connect at least one model first'}
            onClick={() => {
              if (last) void finish();
              else setStep((s) => s + 1);
            }}
          >
            {last ? (finishing ? 'Opening' : 'Open NVX Ancile') : step === 0 ? 'Get started' : 'Continue'}
          </button>
        </div>
      </main>
    </div>
  );
}
