/**
 * ------------------------------------------------------------------
 *  Title    |  Secrets at rest
 *  Ref      |  DESIGN.md §5.8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Provider keys, MCP tokens and OAuth refresh tokens are
 *           |  stored encrypted with ANCILE_SECRET_KEY and decrypted
 *           |  only at the moment of use.
 *  How      |  AES-256-GCM from node:crypto with a random 96-bit nonce
 *           |  per value, and the secret's name bound as associated
 *           |  data so a ciphertext cannot be swapped onto another
 *           |  name. (DESIGN.md mentions libsodium secretbox; node's
 *           |  built-in AEAD gives the same guarantees with no native
 *           |  dependency and none of libsodium-wrappers' ESM issues.)
 * ------------------------------------------------------------------
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';

const ALGO = 'aes-256-gcm';
const TAG_BYTES = 16;

export interface Sealed {
  ciphertext: Buffer; // body || tag
  nonce: Buffer;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('ANCILE_SECRET_KEY must decode to 32 bytes');
    this.key = key;
  }

  seal(name: string, plaintext: string): Sealed {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, nonce);
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
  }

  open(name: string, sealed: Sealed): string {
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.key, sealed.nonce);
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(
        `Secret "${name}" could not be decrypted. ANCILE_SECRET_KEY may have changed; re-enter it in Settings.`,
      );
    }
  }
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  names(): Promise<string[]>;
}

/** For tests and first-boot import before the database is migrated. */
export class MemorySecretStore implements SecretStore {
  private m = new Map<string, Sealed>();
  constructor(private readonly box: SecretBox) {}
  async get(name: string) {
    const s = this.m.get(name);
    return s ? this.box.open(name, s) : undefined;
  }
  async set(name: string, value: string) {
    this.m.set(name, this.box.seal(name, value));
  }
  async delete(name: string) {
    this.m.delete(name);
  }
  async names() {
    return [...this.m.keys()];
  }
}

export class PgSecretStore implements SecretStore {
  constructor(
    private readonly sql: Sql,
    private readonly box: SecretBox,
  ) {}

  async get(name: string): Promise<string | undefined> {
    const rows = await this.sql<
      { ciphertext: Buffer; nonce: Buffer }[]
    >`select ciphertext, nonce from core.secrets where name = ${name}`;
    const row = rows[0];
    return row ? this.box.open(name, { ciphertext: row.ciphertext, nonce: row.nonce }) : undefined;
  }

  async set(name: string, value: string): Promise<void> {
    const { ciphertext, nonce } = this.box.seal(name, value);
    await this.sql`
      insert into core.secrets (id, name, ciphertext, nonce) values (${`sec_${ulid()}`}, ${name}, ${ciphertext}, ${nonce})
      on conflict (name) do update set ciphertext = excluded.ciphertext, nonce = excluded.nonce, rotated_at = now()`;
  }

  async delete(name: string): Promise<void> {
    await this.sql`delete from core.secrets where name = ${name}`;
  }

  async names(): Promise<string[]> {
    return (await this.sql<{ name: string }[]>`select name from core.secrets order by name`).map(
      (r) => r.name,
    );
  }
}

/** Provider keys Ancile will take from the environment once, on first sight. */
export const IMPORTABLE_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/**
 * Copy provider keys from the environment into the encrypted store, without
 * overwriting a key set in Settings. After this the store is the source of
 * truth: rotating a key in the UI wins over a stale .env.
 */
export async function importEnvKeys(
  store: SecretStore,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const have = new Set(await store.names());
  const imported: string[] = [];
  for (const name of IMPORTABLE_KEYS) {
    const value = env[name]?.trim();
    if (value && !have.has(name)) {
      await store.set(name, value);
      imported.push(name);
    }
  }
  return imported;
}
