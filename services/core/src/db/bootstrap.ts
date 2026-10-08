/**
 * ------------------------------------------------------------------
 *  Title    |  Owner bootstrap
 *  Ref      |  DESIGN.md D3 (single user, team-ready)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Ancile ships for one person, but every row already
 *           |  carries a user and a workspace so teams are a feature,
 *           |  not a migration. On first boot this creates that person
 *           |  and their workspace; afterwards it just finds them.
 *  How      |  Idempotent: the oldest owner membership wins, so two
 *           |  Cores starting at once cannot create two owners (the
 *           |  advisory lock serialises them).
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import { ulid } from 'ulid';

export interface Owner {
  userId: string;
  workspaceId: string;
}

const LOCK = 0x41_4e_43_31; // "ANC1"

export async function ensureOwner(sql: Sql): Promise<Owner> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK})`;
    const found = await tx<{ user_id: string; workspace_id: string }[]>`
      select user_id, workspace_id from core.members where role = 'owner' order by workspace_id limit 1`;
    if (found[0]) return { userId: found[0].user_id, workspaceId: found[0].workspace_id };

    const userId = `usr_${ulid()}`;
    const workspaceId = `wsp_${ulid()}`;
    await tx`insert into core.users (id, display_name) values (${userId}, 'You')`;
    await tx`insert into core.workspaces (id, name, slug) values (${workspaceId}, 'Personal', 'personal')`;
    await tx`insert into core.members (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'owner')`;
    return { userId, workspaceId };
  }) as Promise<Owner>;
}
