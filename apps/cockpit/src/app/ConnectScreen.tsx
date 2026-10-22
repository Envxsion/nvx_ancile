/**
 * ------------------------------------------------------------------
 *  Title    |  Connect this browser
 *  Ref      |  DESIGN.md §4.1, §5.8 · docs/api.md (Calling the API)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Core answers only its owner. A browser proves it is the
 *           |  owner's once, and keeps that for 400 days. Until then
 *           |  every call comes back 401 auth.local_key_required, and
 *           |  this screen says so, in place of a workspace of failed
 *           |  requests.
 *  How      |  Any API answer with that code raises the gate
 *           |  (lib/api.ts); the shell then renders only this screen.
 *           |  In a browser it says to run `pnpm pair` in the NVX
 *           |  Ancile folder, which opens this browser again, connected.
 *           |  In the desktop app the window connects itself on start,
 *           |  so it says to restart. A pairing link that was spent or
 *           |  too old comes back to `/?pair=failed`, and the screen
 *           |  says that first.
 *  Note     |  It reuses the start-up screen's layout (pages.css).
 * ------------------------------------------------------------------
 */

import { isDesktop } from '../lib/runtime';
import { Icon } from '../ui/Icon';
import { useConnectGate } from './connect-state';

export { useConnectGate };

export function ConnectScreen() {
  const desktop = isDesktop();
  const failed =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pair') === 'failed';
  return (
    <main className="startup" id="main" aria-labelledby="connect-title">
      <section className="startup__card m-glass">
        <span className="startup__icon" aria-hidden="true">
          <Icon name="lock" size={22} />
        </span>
        <h1 id="connect-title" className="startup__title">
          Connect this browser
        </h1>
        {failed ? (
          <p className="startup__status" role="status">
            <Icon name="clock" size={14} /> That link was used or has expired. Links work once, for a minute.
          </p>
        ) : null}
        <p className="mute startup__lede">
          {desktop
            ? "This window isn't connected to NVX Ancile yet."
            : 'NVX Ancile only answers you, and this browser has not been connected to it yet.'}
        </p>
        {desktop ? (
          <p>Quit NVX Ancile from the tray menu and open it again. The window connects itself on start.</p>
        ) : (
          <>
            <p>In the NVX Ancile folder, run:</p>
            <p className="startup__folder">
              <code>pnpm pair</code>
            </p>
            <p className="mute startup__note">
              It opens this browser again, connected. You do this once for each browser. If the key was
              replaced, run it again. The desktop app connects itself.
            </p>
          </>
        )}
        <div className="startup__actions">
          <button type="button" className="btn btn--primary" onClick={() => window.location.assign('/')}>
            <Icon name="regenerate" size={14} /> Try again
          </button>
        </div>
      </section>
    </main>
  );
}
