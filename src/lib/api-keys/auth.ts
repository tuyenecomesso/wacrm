// ============================================================
// Bearer-key resolution — the single auth path for every `/api/*`
// route (except the Meta webhook challenge).
//
// wacrm has no sessions, cookies, or logins. Identity is established
// exclusively from `Authorization: Bearer <key>`, which is one of:
//
//   * `wacrm_live_…` — a public API key. Stored hashed (SHA-256) in
//     `api_keys`; lookup is by hash, liveness checked, `scopes[]`
//     resolved. Returns `{ kind: 'api_key', accountId, keyId, scopes }`.
//   * `whsec_…`      — a first-party webhook endpoint secret. Stored
//     AES-256-GCM-encrypted in `webhook_endpoints`; matches are
//     constant-time. Returns `{ kind: 'first_party', accountId, endpointId }`.
//
// Anything else (no header, wrong scheme, unknown/revoked/expired key,
// unknown secret) resolves to `null` — the middleware turns that into
// a 401 before any handler runs.
// ============================================================

import { timingSafeEqual } from 'node:crypto';

import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys/keys';
import { findActiveKeyByHash, touchLastUsed } from '@/lib/api-keys/store';
import { WEBHOOK_SECRET_PREFIX } from '@/lib/webhooks/endpoints';
import { listBypassEndpointSecrets } from '@/lib/webhooks/pg-repo';
import { decrypt } from '@/lib/whatsapp/encryption';

export type ResolvedBearerKey =
  | {
      kind: 'api_key';
      accountId: string;
      keyId: string;
      scopes: string[];
      createdBy: string | null;
    }
  | {
      kind: 'first_party';
      accountId: string;
      endpointId: string;
    };

/**
 * Constant-time string comparison. Returns false on any length
 * mismatch (the underlying `timingSafeEqual` throws on unequal
 * lengths). Used for whsec secret matches.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Extract the bearer token from the `Authorization` header. Tolerates
 * the `Bearer ` prefix being absent (some clients send the bare key).
 * Returns null for an absent or empty header.
 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/** Resolve a `whsec_…` token against first-party webhook endpoints. */
async function resolveFirstParty(
  token: string
): Promise<Extract<ResolvedBearerKey, { kind: 'first_party' }> | null> {
  const endpoints = await listBypassEndpointSecrets();
  for (const endpoint of endpoints) {
    let plaintext: string;
    try {
      plaintext = decrypt(endpoint.secret);
    } catch {
      continue;
    }
    if (safeEqual(plaintext, token)) {
      return {
        kind: 'first_party',
        accountId: endpoint.account_id,
        endpointId: endpoint.id,
      };
    }
  }
  return null;
}

/**
 * Resolve an `Authorization` bearer key into an account context, or
 * `null` when there is no usable credential. This is what the
 * middleware calls once per request; handlers read the injected
 * internal headers instead of re-resolving.
 *
 * Side effect: successful API-key resolution bumps `last_used_at`
 * (fire-and-forget — see `store.touchLastUsed`).
 */
export async function resolveBearerKey(
  request: Request
): Promise<ResolvedBearerKey | null> {
  const token = extractBearerToken(request);
  if (!token) return null;

  if (token.startsWith(WEBHOOK_SECRET_PREFIX)) {
    return resolveFirstParty(token);
  }

  if (!looksLikeApiKey(token)) return null;

  const row = await findActiveKeyByHash(hashApiKey(token));
  if (!row) return null; // unknown, revoked, or expired — all 401

  touchLastUsed(row.id);

  return {
    kind: 'api_key',
    accountId: row.account_id,
    keyId: row.id,
    scopes: row.scopes,
    createdBy: row.created_by,
  };
}
