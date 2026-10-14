/**
 * ------------------------------------------------------------------
 *  Title    |  Custom CSS
 *  Ref      |  app/userCss.ts · app/protected.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A person's own CSS, kept on this device. The first time
 *           |  it is applied here, a confirm says what it can do; it
 *           |  never reaches a permission request.
 *  Note     |  CSS saved before (or by an older version) waits, not
 *           |  applied, until it is confirmed here.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { safeMode, userCssOn } from '../../app/userCss';
import { usePrefs } from '../../state/prefs';
import { type ConfirmCopy, ConfirmDialog } from '../../ui/Confirm';
import { Block, Row } from './rows';

export const CSS_CONFIRM: ConfirmCopy = {
  title: 'Apply custom CSS on this device?',
  body: (
    <>
      Your CSS can change how everything looks, so use only CSS you wrote or trust. It stays on this device
      and is switched off while a permission request is open. Open NVX Ancile with ?safe=1 to start without
      it.
    </>
  ),
  action: 'Apply CSS',
};

export function CustomCssBlock() {
  const saved = usePrefs((s) => s.prefs.advanced.css);
  const consent = usePrefs((s) => s.cssConsent);
  const set = usePrefs((s) => s.set);
  const applyCss = usePrefs((s) => s.applyCss);
  const [css, setCss] = useState(saved);
  const [confirm, setConfirm] = useState<ConfirmCopy | null>(null);
  const safe = safeMode();
  const waiting = saved.trim() !== '' && !consent;
  const changed = css !== saved;

  const apply = () => {
    // Clearing it, or changing CSS already confirmed here, needs no confirm.
    if (css.trim() === '' || consent) set('advanced', { css });
    else setConfirm(CSS_CONFIRM);
  };

  return (
    <Block
      title="Custom style"
      lede="Your own CSS, applied after everything else, on this device only. Open NVX Ancile with ?safe=1 to start without it."
    >
      <Row group="advanced" k="css" label="CSS" keywords="custom css theme style" stack>
        <div className="css-editor">
          <textarea
            className="input input--mono css-editor__text"
            rows={8}
            spellCheck={false}
            value={css}
            placeholder={
              ':root { --signal: #c9a362; }\n.msg[data-role="assistant"] { letter-spacing: 0.01em; }'
            }
            onChange={(e) => setCss(e.target.value)}
            aria-label="Custom CSS"
          />
          <div className="css-editor__bar">
            <span className="mute" aria-live="polite">
              {safe && userCssOn({ css: saved, consent, safe: false })
                ? 'Not applied now: this window was opened with ?safe=1.'
                : waiting && !changed
                  ? 'Saved but not applied on this device yet. Apply it to confirm.'
                  : 'Uses the same tokens as NVX Ancile: --signal, --lift, --fg and the rest.'}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!changed && !waiting}
              onClick={apply}
            >
              Apply
            </button>
          </div>
        </div>
      </Row>
      <ConfirmDialog copy={confirm} onConfirm={() => applyCss(css)} onClose={() => setConfirm(null)} />
    </Block>
  );
}
