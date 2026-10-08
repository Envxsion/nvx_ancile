/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the sign-in gate
 *  Ref      |  DESIGN.md §9
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When the workspace has a team (Pro) and nobody is signed
 *           |  in, show the sign-in screen instead of a workspace full
 *           |  of failed requests.
 *  How      |  Any API answer `auth.sign_in_required` raises the gate
 *           |  (lib/api.ts); the shell then renders only the gate. The
 *           |  screen itself is Pro's ("signin" surface). Signing in
 *           |  reloads the page, which lowers the gate.
 *  Note     |  A single-person install never sees it: its identity is
 *           |  always the owner.
 * ------------------------------------------------------------------
 */

import '../styles/pro.css';
import { useSignInGate } from './signin-state';
import { ProSurfaceView } from './slot';

export { useSignInGate };

export function SignInGate() {
  return (
    <main className="signin-gate" id="main">
      <ProSurfaceView id="signin" />
    </main>
  );
}
