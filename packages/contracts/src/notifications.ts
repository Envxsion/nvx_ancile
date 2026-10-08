/**
 * ------------------------------------------------------------------
 *  Title    |  Notifications
 *  Ref      |  DESIGN.md §4.1 (State), §13.4
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The notification centre's history: every notice Core
 *           |  sent, kept so it survives a reload, with read state.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const NotificationItem = z.object({
  id: z.string(),
  kind: z.string(),
  level: z.enum(['info', 'success', 'warn', 'error']),
  title: z.string(),
  body: z.string().nullable(),
  action: z.object({ label: z.string(), href: z.string() }).nullable(),
  trace_id: z.string().nullable(),
  read_at: z.string().nullable(),
  created_at: z.string(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationList = z.object({
  items: z.array(NotificationItem),
  unread: z.number().int(),
  next_cursor: z.string().nullable(),
});
export type NotificationList = z.infer<typeof NotificationList>;

/** POST /notifications/read: some ids, or everything up to now. */
export const MarkNotificationsRead = z
  .object({ ids: z.array(z.string()).max(500).optional(), all: z.boolean().optional() })
  .strict()
  .refine((r) => r.all || (r.ids?.length ?? 0) > 0, { message: 'Give ids, or all: true' });
export type MarkNotificationsRead = z.infer<typeof MarkNotificationsRead>;
