/**
 * ------------------------------------------------------------------
 *  Title    |  Admin → Models, grouped by who pays
 *  Ref      |  docs/claude-code.md (Plan or key) · roadmap MD3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The same Claude model can sit on your plan and on an
 *           |  API key. This groups the list so it is clear which is
 *           |  which: subscriptions, API keys, then your computer and
 *           |  GPU nodes.
 *  How      |  groupModels sorts the listed models by the billing Core
 *           |  sends. Subscriptions is one block for Claude Code: the
 *           |  plan in words, the account, the plan's limits left, then
 *           |  its models (greyed with "Sign in" when signed out).
 *           |  Claude Code on an API key or a cloud account is listed
 *           |  under API keys instead. Each key block shows its key's
 *           |  state and every model's price per million tokens.
 *  Note     |  The account email is read from Core's status and shown
 *           |  here to the owner only; it is not stored or sent on.
 * ------------------------------------------------------------------
 */

import { isClaudeCodeModel } from '@nvx/contracts';
import { useNavigate } from '@tanstack/react-router';
import { type CSSProperties, useState } from 'react';
import { startClaudeCodeSignIn, useClaudeCodeStatus } from '../../claudecode/api';
import { statusText, useCredentials } from '../../credentials/ApiKeys';
import { modelKind } from '../../engines/api';
import { hueVar, usd } from '../../lib/format';
import type { ModelView } from '../../lib/types';
import { billingTitle, billingWords, modelBadge } from '../../models/billing';
import { ModelMenu } from '../../models/EditModel';
import { notify } from '../../state/notify';
import { Icon } from '../../ui/Icon';
import { StatusDot } from '../../ui/primitives';
import { PlanLimits } from '../../usage/PlanLimits';

const STATUS_WORDS = {
  ready: 'Ready',
  needs_key: 'Needs its key',
  disabled: 'Off',
  not_pulled: 'Not pulled',
  signed_out: 'Signed out',
} as const;

export interface KeyBlock {
  /** The payer id: a provider, or the cloud Claude Code bills. */
  payer: string;
  /** Claude Code's models on an API key or cloud account, not a provider's own. */
  viaClaudeCode: boolean;
  title: string;
  models: ModelView[];
}

export interface ModelBlocks {
  subscription: ModelView[];
  keys: KeyBlock[];
  local: ModelView[];
}

const CLOUD_TITLE: Record<string, string> = {
  anthropic: 'Claude Code on your Anthropic API key',
  bedrock: 'Claude Code on Amazon Bedrock',
  vertex: 'Claude Code on Google Vertex AI',
  foundry: 'Claude Code on Microsoft Foundry',
};

/** Sort the listed models into subscriptions, API keys and your own computers. Pure. */
export function groupModels(models: ModelView[]): ModelBlocks {
  const out: ModelBlocks = { subscription: [], keys: [], local: [] };
  const block = (payer: string, viaClaudeCode: boolean, m: ModelView) => {
    let b = out.keys.find((k) => k.payer === payer && k.viaClaudeCode === viaClaudeCode);
    if (!b) {
      b = {
        payer,
        viaClaudeCode,
        title: viaClaudeCode ? (CLOUD_TITLE[payer] ?? `Claude Code on ${payer}`) : `${m.provider} API key`,
        models: [],
      };
      out.keys.push(b);
    }
    b.models.push(m);
  };
  for (const m of models) {
    const billing = m.billing;
    if (isClaudeCodeModel(m.id)) {
      if (billing?.kind === 'key') block(billing.payer ?? 'anthropic', true, m);
      else out.subscription.push(m);
    } else if (billing) {
      if (billing.kind === 'key') block(billing.payer ?? m.provider, false, m);
      else out.local.push(m);
    } else if (modelKind(m) === 'local') out.local.push(m);
    else block(m.provider, false, m);
  }
  return out;
}

const perM = (n: number) => usd(n, Number.isInteger(n) ? 0 : 2);

function priceWords(m: ModelView): string | null {
  if (m.billing?.kind !== 'key' || !m.price || (!m.price.in && !m.price.out)) return null;
  return `${perM(m.price.in)} in · ${perM(m.price.out)} out per M`;
}

function ModelRow({ m }: { m: ModelView }) {
  const price = priceWords(m);
  return (
    <li
      className="row row--health row--model"
      data-status={m.status === 'ready' ? 'ok' : 'idle'}
      data-signed-out={m.status === 'signed_out' || undefined}
    >
      <StatusDot status={m.status === 'ready' ? 'ok' : 'idle'} label={STATUS_WORDS[m.status ?? 'ready']} />
      <span className="row__title">
        <span className="model-hue" aria-hidden="true" style={{ '--hue': hueVar(m.hue) } as CSSProperties} />
        <span className="row__name" title={m.name}>
          {m.name}
        </span>
        {m.custom ? <span className="tag model-added">Added</span> : null}
        {m.billing ? (
          <span className="model-badge" title={billingTitle(m.billing, m.price)}>
            {modelBadge(m)}
          </span>
        ) : null}
      </span>
      <span className="row__meta">
        {m.provider} · {STATUS_WORDS[m.status ?? 'ready']}
        {price ? ` · ${price}` : ''}
        {m.note && m.status !== 'needs_key' && m.status !== 'signed_out' ? ` · ${m.note}` : ''}
      </span>
      <span data-num className="mute row__num">
        {m.contextWindow.toLocaleString('en-GB')} tok
      </span>
      <ModelMenu model={m} />
    </li>
  );
}

function Block({
  title,
  lede,
  actions,
  children,
  id,
}: {
  title: string;
  lede?: string | undefined;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <section className="model-block" aria-labelledby={id}>
      <header className="model-block__head">
        <h3 id={id} className="admin__h model-block__title">
          {title}
        </h3>
        {actions}
      </header>
      {lede ? <p className="mute model-block__lede">{lede}</p> : null}
      {children}
    </section>
  );
}

/** Claude Code's block: the plan in words, the account, the limits left, then its models. */
function Subscriptions({ models }: { models: ModelView[] }) {
  const status = useClaudeCodeStatus();
  const [asked, setAsked] = useState(false);
  const s = status.data;
  const signedOut = s?.signed_in === false || models.every((m) => m.status === 'signed_out');
  const billing = models.find((m) => m.billing)?.billing;
  const words = billing ? billingWords(billing) : 'Your Claude plan';
  const signIn = async () => {
    if (await startClaudeCodeSignIn()) {
      setAsked(true);
      notify({
        level: 'info',
        title: 'Claude Code sign-in opened in your browser',
        body: 'Sign in there; this list updates when you are done.',
      });
    }
  };
  return (
    <Block
      id="models-subscriptions"
      title="Subscriptions"
      lede="Answers counted against a plan you are signed in to. They run as Claude Code, with its own tools and session."
    >
      <div className="model-plan">
        <div className="model-plan__who">
          <span className="model-plan__name">Claude Code</span>
          {signedOut ? (
            <span className="mute">Not signed in</span>
          ) : (
            <span className="mute">
              {words}
              {s?.account ? ` · Signed in as ${s.account}` : ''}
            </span>
          )}
        </div>
        {signedOut ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void signIn()}
            disabled={asked}
          >
            <Icon name="terminal" size={14} />
            {asked ? 'Waiting for Claude Code' : 'Sign in'}
          </button>
        ) : null}
      </div>
      {s?.signed_in ? (
        <div className="model-plan__limits">
          <PlanLimits compact />
        </div>
      ) : null}
      <ul className="rows">
        {models.map((m) => (
          <ModelRow key={m.id} m={m} />
        ))}
      </ul>
    </Block>
  );
}

function KeysBlock({ b, i }: { b: KeyBlock; i: number }) {
  const navigate = useNavigate();
  const creds = useCredentials().data;
  // The key's state, for a provider that has a stored key; Claude Code's own sign-in has none here.
  const cred = b.viaClaudeCode ? undefined : creds?.find?.((c) => c.id === b.payer);
  const missing = !!creds && !b.viaClaudeCode && !!cred && !cred.set;
  return (
    <Block
      id={`models-keys-${i}`}
      title={b.title}
      lede={
        b.viaClaudeCode
          ? 'Claude Code is signed in with this, so its answers are pay per use. They still run as Claude Code, with its own tools and session.'
          : undefined
      }
      actions={
        b.viaClaudeCode ? null : (
          <span className="model-block__key">
            {cred ? <span className="mute">{statusText(cred)}</span> : null}
            <button
              type="button"
              className="link-btn link-btn--quiet"
              onClick={() => void navigate({ to: '/settings/$group', params: { group: 'keys' } })}
            >
              {missing ? 'Add the key in Settings → API keys' : 'Manage keys'}
            </button>
          </span>
        )
      }
    >
      <ul className="rows">
        {b.models.map((m) => (
          <ModelRow key={m.id} m={m} />
        ))}
      </ul>
    </Block>
  );
}

/** The listed models in three groups: subscriptions, API keys, your computer and GPU nodes. */
export function ModelBlocksView({ models }: { models: ModelView[] }) {
  const g = groupModels(models);
  return (
    <div className="model-blocks">
      {g.subscription.length ? <Subscriptions models={g.subscription} /> : null}
      {g.keys.map((b, i) => (
        <KeysBlock key={`${b.viaClaudeCode ? 'cc' : 'p'}:${b.payer}`} b={b} i={i} />
      ))}
      {g.local.length ? (
        <Block id="models-local" title="On your computer and GPU nodes">
          <ul className="rows">
            {g.local.map((m) => (
              <ModelRow key={m.id} m={m} />
            ))}
          </ul>
        </Block>
      ) : null}
    </div>
  );
}
