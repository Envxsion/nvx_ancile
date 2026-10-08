/**
 * ------------------------------------------------------------------
 *  Title    |  Request bodies
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Parse a JSON body against its contract schema and turn
 *           |  any mismatch into the standard 400, naming the field.
 * ------------------------------------------------------------------
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from '../obs/errors';

export async function body<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('The body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(
      first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'The body does not match the contract',
    );
  }
  return parsed.data;
}
