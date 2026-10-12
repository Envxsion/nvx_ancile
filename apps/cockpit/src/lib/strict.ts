/**
 * ------------------------------------------------------------------
 *  Title    |  Strict runtime
 *  Ref      |  packages/contracts/src/csp.ts · docs/desktop.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit runs with no eval (script-src has no
 *           |  'unsafe-eval'). zod would try new Function once to see
 *           |  whether it may compile fast parsers, which the policy
 *           |  reports as a violation; jitless keeps it from trying.
 *  How      |  Imported first by main.tsx, before any schema parses.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

z.config({ jitless: true });
