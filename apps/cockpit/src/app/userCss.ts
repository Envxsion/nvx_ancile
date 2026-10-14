/**
 * ------------------------------------------------------------------
 *  Title    |  Custom CSS
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A person's own CSS, last in the cascade, on this device
 *           |  only, and only once they have confirmed it here.
 *  How      |  One <style id="ancile-user-css">. It is applied when
 *           |  there is CSS, it was confirmed on this device, the page
 *           |  was not opened with ?safe=1, and no protected surface
 *           |  (a permission request) is open; otherwise it is
 *           |  switched off. The saved CSS itself is never edited.
 * ------------------------------------------------------------------
 */

export const USER_CSS_ID = 'ancile-user-css';

export interface UserCssState {
  css: string;
  /** Confirmed on this device (the first-time confirm). */
  consent: boolean;
  /** Opened with ?safe=1. */
  safe: boolean;
  /** A protected surface is open. */
  suspended: boolean;
}

/** Whether the CSS is in force now, as the "Custom CSS on" chip says. */
export function userCssOn(s: Omit<UserCssState, 'suspended'>): boolean {
  return s.css.trim() !== '' && s.consent && !s.safe;
}

/** Put the document in step with the state. Returns whether the CSS applies right now. */
export function applyUserCss(s: UserCssState, doc: Document = document): boolean {
  let el = doc.getElementById(USER_CSS_ID) as HTMLStyleElement | null;
  if (!userCssOn(s)) {
    el?.remove();
    return false;
  }
  if (!el) {
    el = doc.createElement('style');
    el.id = USER_CSS_ID;
    doc.head.appendChild(el);
  }
  // Off while a permission request is open: the element empties and the
  // saved CSS is untouched, so it comes back exactly as it was.
  const text = s.suspended ? '' : s.css;
  if (el.textContent !== text) el.textContent = text;
  if (s.suspended) el.dataset.suspended = '';
  else delete el.dataset.suspended;
  return !s.suspended;
}

export function safeMode(): boolean {
  try {
    return new URLSearchParams(location.search).has('safe');
  } catch {
    return false;
  }
}
