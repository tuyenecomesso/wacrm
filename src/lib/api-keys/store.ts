// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Direct-Postgres port of the old Supabase service-role reads. There
// is no RLS anymore (no auth.uid() to key off — wacrm has no sessions);
// tenancy is enforced by every query carrying `account_id` and by the
// middleware establishing the account from the key hash itself.
//
// Generation lives in `./keys.ts` (`generateApiKey`): it returns the
// plaintext exactly once alongside the SHA-256 hash + display prefix.
// This file only persists / looks up / revokes.
// ============================================================

import { getPool } from '@/lib/pg';
import { getAccountNameById } from '@/lib/db/repos/accounts';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/** Columns safe to expose over the API. `key_hash` is deliberately excluded. */
export const API_KEY_SAFE_COLUMNS =
  'id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at';

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no
 * row matches, or if the matching row is revoked or expired — so
 * callers never have to re-check liveness. The hash is the only
 * credential; this is the moment that establishes the caller's
 * account.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  const { rows } = await getPool().query<ApiKeyRow>(
    `SELECT id, account_id, created_by, name, scopes, expires_at, revoked_at
     FROM api_keys
     WHERE key_hash = $1
     LIMIT 1`,
    [hash]
  );

  const row = rows[0];
  if (!row) return null;

  // Liveness checks in JS rather than SQL so the failure modes are
  // explicit and the index stays a simple equality lookup.
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return row;
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` and any
 * future endpoint can echo it without a second round trip in the
 * route. The key already proved account membership.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  return getAccountNameById(accountId);
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth
 * path — a failed update just means the "last used" column lags;
 * it must never fail the request the caller is actually making.
 */
export function touchLastUsed(id: string): void {
  void getPool()
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [id])
    .catch((error: unknown) => {
      console.warn(
        '[api-keys/store] last_used_at bump failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
}

/** List an account's keys, newest first. Safe columns only. */
export async function listKeys(accountId: string): Promise<unknown[]> {
  const { rows } = await getPool().query(
    `SELECT ${API_KEY_SAFE_COLUMNS}
     FROM api_keys
     WHERE account_id = $1
     ORDER BY created_at DESC`,
    [accountId]
  );
  return rows;
}

/**
 * Persist a freshly generated key. The caller holds the plaintext
 * from `generateApiKey()` and passes the hash; only the hash is ever
 * stored. Returns the safe-columns row.
 */
export async function insertKey(input: {
  accountId: string;
  createdBy: string | null;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  expiresAt: string | null;
}): Promise<unknown> {
  const { rows } = await getPool().query(
    `INSERT INTO api_keys
       (account_id, created_by, name, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${API_KEY_SAFE_COLUMNS}`,
    [
      input.accountId,
      input.createdBy,
      input.name,
      input.keyPrefix,
      input.keyHash,
      input.scopes,
      input.expiresAt,
    ]
  );
  return rows[0];
}

/**
 * Revoke a key belonging to the given account. Returns false if no
 * row matched (wrong account or unknown id).
 */
export async function revokeKey(
  accountId: string,
  keyId: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE api_keys
     SET revoked_at = now()
     WHERE id = $1 AND account_id = $2`,
    [keyId, accountId]
  );
  return (rowCount ?? 0) > 0;
}
