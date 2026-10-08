/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: what Core lends Pro's features
 *  Ref      |  DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn Core's own pieces (the database, the Controller
 *           |  client, the event bus, the licence) into the small
 *           |  surfaces Pro is allowed to use.
 *  How      |  Plain adapters: no Pro logic lives here, so the free
 *           |  build carries nothing but the plumbing.
 * ------------------------------------------------------------------
 */

import type { pro as proContract } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import type { ControllerClient } from '../compute/controller';
import type { EventBus } from '../events/bus';
import type { ProAnswers, ProController, ProDb, ProNotice, ProServices, ProSyncSource } from './types';

export function proDb(sql: Sql): ProDb {
  const query = <T>(text: string, params: unknown[] = []) =>
    sql.unsafe(text, params as never[]) as unknown as Promise<T[]>;
  return {
    query,
    transaction: (fn) =>
      sql.begin((tx) =>
        fn({
          query: <T>(text: string, params: unknown[] = []) =>
            tx.unsafe(text, params as never[]) as unknown as Promise<T[]>,
        }),
      ) as never,
  };
}

export function proController(client: ControllerClient): ProController {
  return {
    configured: client.configured,
    get: (path) => client.get(path),
    // The Controller has no PATCH; Pro's partial updates go as PUT.
    send: (method, path, body) => client.send(method === 'PATCH' ? 'PUT' : method, path, body),
  };
}

export function proNotify(events: EventBus): (n: ProNotice) => void {
  return (n) =>
    void events
      .publish({
        type: 'notification',
        id: `ntf_pro_${ulid()}`,
        level: n.level,
        title: n.title,
        ...(n.body && { body: n.body }),
        ...(n.action && { action: n.action }),
        ...(n.category && { category: n.category }),
      })
      .catch(() => {
        /* a notice that cannot be shown is not worth failing Pro's work over */
      });
}

export function proServices(deps: {
  sql: Sql;
  controller: ControllerClient;
  events: EventBus;
  hasFeature: (f: proContract.ProFeature) => boolean;
  owner: { userId: string; workspaceId: string };
  sync?: ProSyncSource;
  answers?: ProAnswers;
}): ProServices {
  return {
    db: proDb(deps.sql),
    controller: proController(deps.controller),
    notify: proNotify(deps.events),
    hasFeature: deps.hasFeature,
    owner: deps.owner,
    ...(deps.sync && { sync: deps.sync }),
    ...(deps.answers && { answers: deps.answers }),
    now: () => new Date(),
  };
}
