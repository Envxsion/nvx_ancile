/**
 * ------------------------------------------------------------------
 *  Title    |  Connection banner
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When Core stops answering, say so once, plainly, and
 *           |  keep everything already loaded on screen. When it comes
 *           |  back, say that too, then get out of the way.
 *  How      |  Reads lib/connection.ts. "Try now" refetches what is on
 *           |  screen; Core also restarts on its own.
 * ------------------------------------------------------------------
 */

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../lib/connection';
import { queryClient } from '../lib/query';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';

export function ConnectionBanner() {
  const status = useConnection((s) => s.status);
  const since = useConnection((s) => s.since);
  const [back, setBack] = useState(false);
  const was = useRef(status);
  const [, tick] = useState(0);

  useEffect(() => {
    if (was.current === 'offline' && status === 'online') {
      setBack(true);
      void queryClient.invalidateQueries();
      const t = setTimeout(() => setBack(false), 3_000);
      was.current = status;
      return () => clearTimeout(t);
    }
    was.current = status;
  }, [status]);

  useEffect(() => {
    if (status !== 'offline') return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    // Probe now and then so the banner clears without anyone clicking.
    const probe = setInterval(() => void queryClient.refetchQueries({ queryKey: ['system-health'] }), 5_000);
    return () => {
      clearInterval(t);
      clearInterval(probe);
    };
  }, [status]);

  const minutes = since ? Math.floor((Date.now() - since) / 60_000) : 0;

  return (
    <AnimatePresence>
      {status === 'offline' ? (
        <motion.div
          key="off"
          className="conn-banner"
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
        >
          <Icon name="warn" size={14} />
          <span>
            <strong>Core is not answering</strong>
            {minutes > 0 ? ` (for ${minutes} min)` : ''}. What you see is what was last loaded; nothing you
            sent is lost.
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void queryClient.refetchQueries({ type: 'active' })}
          >
            Try now
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => useUi.getState().setHelp(true, 'offline')}
          >
            What to do
          </button>
        </motion.div>
      ) : back ? (
        <motion.div
          key="back"
          className="conn-banner"
          data-back
          role="status"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
        >
          <Icon name="check" size={14} />
          <span>Core is back. Everything is up to date again.</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
