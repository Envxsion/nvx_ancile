/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop theme file
 *  Ref      |  ROADMAP D7
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The desktop shell paints its window and splash before
 *           |  anything runs, so it needs the theme the Cockpit saved.
 *  How      |  PUT /system/desktop/theme writes one word (dark, light
 *           |  or system) to <data>/theme; the shell reads it at launch.
 * ------------------------------------------------------------------
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';

const Theme = z.object({ theme: z.enum(['dark', 'light', 'system']) }).strict();

export function themeRoutes(dataDir: string) {
  const r = new Hono<AppEnv>();
  r.put('/system/desktop/theme', async (c) => {
    const { theme } = await body(c, Theme);
    await writeFile(join(dataDir, 'theme'), theme, 'utf8');
    return c.body(null, 204);
  });
  return r;
}
