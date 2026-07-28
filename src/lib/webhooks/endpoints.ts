import { randomBytes } from 'node:crypto';

/** Secret prefix — self-identifying, like `wacrm_live_` for keys. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Columns safe to return over the API — everything except the
 * (encrypted) `secret`, which is only ever surfaced once at creation.
 */
export const WEBHOOK_PUBLIC_COLUMNS =
  'id, url, events, is_active, last_delivery_at, failure_count, created_at, name';

export interface ApiWebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
  name: string | null;
}

/** Generate a fresh signing secret (full-entropy, URL/header-safe). */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Project a `WEBHOOK_PUBLIC_COLUMNS` row into the API shape. */
export function serializeWebhookEndpoint(
  row: Record<string, unknown>
): ApiWebhookEndpoint {
  return {
    id: row.id as string,
    url: row.url as string,
    events: (row.events as string[] | null) ?? [],
    is_active: Boolean(row.is_active),
    last_delivery_at: (row.last_delivery_at as string | null) ?? null,
    failure_count: (row.failure_count as number | null) ?? 0,
    created_at: row.created_at as string,
    name: (row.name as string | null) ?? null,
  };
}

/**
 * Validate a webhook target URL: must be a well-formed absolute
 * `https://` URL (an unencrypted `http://` sink would leak signed
 * event payloads). Returns the normalized string or null.
 *
 * When `allowHttp` is true, `http://` is also accepted — this is
 * intended for first-party integrations on internal networks.
 */
export function normalizeWebhookUrl(
  input: unknown,
  allowHttp = false
): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'https:') return u.toString();
    if (allowHttp && u.protocol === 'http:') return u.toString();
    return null;
  } catch {
    return null;
  }
}
