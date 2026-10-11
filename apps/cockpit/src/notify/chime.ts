/**
 * ------------------------------------------------------------------
 *  Title    |  The decision chime
 *  Ref      |  Settings → Notifications · "A soft sound for decisions"
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One quiet sound when something waits for your yes or
 *           |  no, and for nothing else.
 *  How      |  Two sine notes a fifth apart, built in Web Audio. The
 *           |  approval event and an approvals toast can both arrive
 *           |  for one request, so it sounds at most once a second.
 * ------------------------------------------------------------------
 */

import type { Notice } from '../state/notify';
import { usePrefs } from '../state/prefs';

let audio: AudioContext | null = null;
let lastAt = 0;

/** The chime is for decisions only: a request waiting for your yes or no. */
export function shouldChime(sound: boolean, n: Pick<Notice, 'category'>): boolean {
  return sound && n.category === 'approvals';
}

/** Sound the chime, if the setting is on and it has not just sounded. */
export function decisionChime(now = Date.now()): boolean {
  if (!usePrefs.getState().prefs.notifications.sound || now - lastAt < 1000) return false;
  lastAt = now;
  try {
    audio ??= new AudioContext();
    const at = audio.currentTime;
    for (const [i, f] of [660, 990].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, at + i * 0.09);
      gain.gain.linearRampToValueAtTime(0.05, at + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.09 + 0.32);
      osc.connect(gain).connect(audio.destination);
      osc.start(at + i * 0.09);
      osc.stop(at + i * 0.09 + 0.34);
    }
  } catch {
    /* no audio device, or blocked until a gesture: stay silent */
  }
  return true;
}
