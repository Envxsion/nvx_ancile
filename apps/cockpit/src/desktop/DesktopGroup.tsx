/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Desktop
 *  Ref      |  ROADMAP rows DK1, UP1 · docs/desktop.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the desktop app does with its window and with
 *           |  updates: what closing the window does, and the update
 *           |  card with its notes, size, progress and the three ways
 *           |  to install (Restart now, When I quit, Tonight).
 *  How      |  Shown only inside the desktop app. Every button is a
 *           |  request to Core, which the desktop shell picks up
 *           |  (desktop/api.ts). Nothing downloads or installs until
 *           |  a button is pressed, so a metered connection is always
 *           |  asked first. Pro (feature "desktop"): the Beta channel
 *           |  and Go back to the previous version, which backs the
 *           |  data up first; in the free edition both say so.
 *  Note     |  Restart waits for runs and approvals: the desktop
 *           |  shell asks whether to stop them or wait.
 * ------------------------------------------------------------------
 */

import type { CloseBehaviour, license } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { useContext, useState } from 'react';
import { ApiCallError } from '../lib/api';
import { useProFeature } from '../pro/slot';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { ConfirmDialog } from '../ui/Confirm';
import { Segmented } from '../ui/controls';
import { Icon } from '../ui/Icon';
import {
  CLOSE_WORDS,
  command,
  offerLine,
  setChannel,
  setClose,
  sizeText,
  tonightText,
  useDesktopState,
  useUpdateChannel,
  useUpdateOffer,
} from './api';
import '../styles/desktop.css';

type Offer = NonNullable<license.UpdateOffer['offer']>;

function fail(title: string) {
  return (err: unknown) =>
    notify({
      level: 'error',
      title,
      body:
        err instanceof ApiCallError
          ? err.body.error.hint
          : 'Check that NVX Ancile is running, then try again.',
    });
}

/** Settings → Desktop closing choice. */
function ClosingRow() {
  const q = useContext(SearchContext);
  const state = useDesktopState();
  if (!matches(q, 'When I close the window', 'close tray quit background keep running', 'desktop'))
    return null;
  return (
    <div className="setting">
      <div className="setting__words">
        <div className="setting__label">
          <span>When I close the window</span>
        </div>
        <p className="setting__desc">
          Keeping NVX Ancile in the tray means runs, Claude Code threads and checks carry on while the window
          is closed. Quitting stops everything, after asking about runs still working.
        </p>
      </div>
      <div className="setting__control">
        <Segmented<CloseBehaviour>
          label="When I close the window"
          value={state.data?.close ?? 'ask'}
          onChange={(close) => void setClose(close).catch(fail('Not saved'))}
          options={(['ask', 'tray', 'quit'] as const).map((value) => ({ value, label: CLOSE_WORDS[value] }))}
        />
      </div>
    </div>
  );
}

function Notes({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="update-card__notes">
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide what changed' : 'What changed'}
      </button>
      {open ? <p className="update-card__notes-body">{text}</p> : null}
    </div>
  );
}

function Progress({ value }: { value: number | null }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <div
      className="update-card__bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Download progress"
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function UpdateCard({ offer, version }: { offer: Offer | null; version: string | null }) {
  const run = (kind: Parameters<typeof command>[0], title: string) => () =>
    void command(kind).catch(fail(title));
  if (!offer)
    return (
      <div className="update-card">
        <p className="update-card__line">
          <Icon name="check" size={14} /> NVX Ancile {version ?? ''} is up to date.
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={run('update.check', 'Could not check for updates')}
        >
          Check for updates
        </button>
      </div>
    );

  const busy = offer.state === 'downloading' || offer.state === 'installing';
  const scheduled = offer.when !== 'none';
  return (
    <div className="update-card" data-state={offer.state}>
      <p className="update-card__line">
        <Icon name="download" size={14} /> <strong>NVX Ancile {offer.version}</strong>
        <span className="mute"> {offerLine(offer).replace(`${offer.version} `, '')}</span>
      </p>
      {offer.kind === 'pro' ? <p className="mute">Pro is ready. Installing it turns Pro on here.</p> : null}
      {offer.kind === 'downgrade' ? (
        <p className="mute">Pro ended. This installs the free edition. Your data stays.</p>
      ) : null}
      {offer.older ? (
        <p className="update-card__warn">
          This is older than the version running now. NVX Ancile backs up your data first, and the older
          version then offers that backup.
        </p>
      ) : null}
      {offer.size_bytes ? <p className="mute">Download size {sizeText(offer.size_bytes)}.</p> : null}
      {offer.state === 'downloading' ? <Progress value={offer.progress} /> : null}
      {offer.state === 'failed' ? (
        <p className="update-card__warn" role="alert">
          {offer.error ?? 'The update did not install.'}
        </p>
      ) : null}
      {scheduled && offer.when === 'tonight' ? (
        <p className="mute">
          Installs {tonightText(offer.scheduled_for)}, once nothing is running. Nothing is lost if you open
          NVX Ancile first.
        </p>
      ) : null}
      {offer.notes ? <Notes text={offer.notes} /> : null}
      <div className="update-card__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={run('update.restart_now', 'Could not start the update')}
        >
          Restart now
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy || offer.when === 'quit'}
          onClick={run('update.on_quit', 'Could not schedule the update')}
        >
          When I quit
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy || offer.when === 'tonight'}
          onClick={run('update.tonight', 'Could not schedule the update')}
        >
          Tonight
        </button>
        {scheduled ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={run('update.cancel', 'Could not cancel')}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <p className="mute update-card__fine">
        Restart now waits for runs and approvals, or asks whether to stop them. Nothing downloads until you
        choose.
      </p>
    </div>
  );
}

/** Beta, and Go back: Pro's two update extras. */
function ProUpdateRows({ previous }: { previous: string | null }) {
  const q = useContext(SearchContext);
  const pro = useProFeature('desktop');
  const channel = useUpdateChannel();
  const [confirm, setConfirm] = useState(false);
  const show = matches(q, 'Update channel beta stable', 'Go back to the previous version', 'updates pro');
  if (!show) return null;
  const locked = !pro.unlocked;
  return (
    <>
      <div className="setting">
        <div className="setting__words">
          <div className="setting__label">
            <span>Update channel</span>
            {locked ? <span className="pro-tag">Pro</span> : null}
          </div>
          <p className="setting__desc">
            Beta gets new versions earlier and may be rougher. {locked ? 'Beta is part of Pro. ' : ''}
            {locked ? (
              <Link to="/admin/$section" params={{ section: 'license' }}>
                See Pro
              </Link>
            ) : null}
          </p>
        </div>
        <div className="setting__control">
          <Segmented<'stable' | 'beta'>
            label="Update channel"
            value={channel.data?.channel ?? 'stable'}
            onChange={(c) => void setChannel(c).catch(fail('Could not change the channel'))}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: locked ? 'Beta (Pro)' : 'Beta' },
            ]}
          />
        </div>
      </div>
      <div className="setting">
        <div className="setting__words">
          <div className="setting__label">
            <span>Go back to the previous version</span>
            {locked ? <span className="pro-tag">Pro</span> : null}
          </div>
          <p className="setting__desc">
            {previous
              ? `Installs ${previous}, the version before the last update. Your data is backed up first.`
              : 'Available right after an update, while the previous version is still known.'}
          </p>
        </div>
        <div className="setting__control">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={locked || !previous}
            onClick={() => setConfirm(true)}
          >
            Go back{previous ? ` to ${previous}` : ''}
          </button>
        </div>
      </div>
      <ConfirmDialog
        copy={
          confirm
            ? {
                title: `Go back to ${previous}?`,
                body: (
                  <>
                    <p>
                      NVX Ancile backs up your data, then installs {previous} and restarts. Anything the newer
                      version changed in your data may not open in the older one; the backup from before the
                      update is offered if so.
                    </p>
                    <p>It waits for runs and approvals first, or asks whether to stop them.</p>
                  </>
                ),
                action: `Back up and go back to ${previous}`,
                keep: 'Stay on this version',
              }
            : null
        }
        onConfirm={() => void command('update.go_back').catch(fail('Could not go back'))}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}

/** Settings → Desktop. */
export function DesktopGroup() {
  const state = useDesktopState();
  const offer = useUpdateOffer();
  const version = typeof window === 'undefined' ? null : (window.__NVX_DESKTOP__?.version ?? null);
  return (
    <>
      <Block title="Window">
        <ClosingRow />
      </Block>
      <Block title="Updates" lede="NVX Ancile never installs an update without you choosing when.">
        <div className="setting" data-stack>
          <UpdateCard offer={offer.data?.offer ?? null} version={version} />
        </div>
        <ProUpdateRows previous={state.data?.last_update?.from ?? null} />
      </Block>
    </>
  );
}
