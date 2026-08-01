import { getPool } from '@/lib/pg'

export interface WebhookEndpointRow {
  id: string
  account_id: string
  created_by: string | null
  name: string | null
  url: string
  secret: string
  events: string[]
  is_active: boolean
  bypass_ssrf: boolean
  last_delivery_at: string | null
  failure_count: number
  created_at: string
}

export interface EndpointDeliveryRow {
  id: string
  url: string
  secret: string
  bypass_ssrf: boolean
}

const ROW_COLUMNS =
  'id, account_id, created_by, name, url, secret, events, is_active, bypass_ssrf, last_delivery_at, failure_count, created_at'

export async function insertWebhookEndpoint(input: {
  accountId: string
  url: string
  name: string
  secret: string
  events: string[]
  bypassSsrf: boolean
}): Promise<WebhookEndpointRow> {
  const { rows } = await getPool().query<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints (account_id, url, name, secret, events, bypass_ssrf)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ROW_COLUMNS}`,
    [input.accountId, input.url, input.name, input.secret, input.events, input.bypassSsrf]
  )
  return rows[0]
}

export async function deleteWebhookEndpointByAccountAndName(
  accountId: string,
  name: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM webhook_endpoints
     WHERE account_id = $1 AND name = $2 AND bypass_ssrf = true`,
    [accountId, name]
  )
  return (rowCount ?? 0) > 0
}

export async function listActiveEndpointsForEvent(
  accountId: string,
  event: string
): Promise<EndpointDeliveryRow[]> {
  const { rows } = await getPool().query<EndpointDeliveryRow>(
    `SELECT id, url, secret, bypass_ssrf
     FROM webhook_endpoints
     WHERE account_id = $1 AND is_active = true AND events @> ARRAY[$2]`,
    [accountId, event]
  )
  return rows
}

export async function markWebhookEndpointDelivered(id: string): Promise<void> {
  await getPool().query(
    `UPDATE webhook_endpoints
     SET failure_count = 0, last_delivery_at = now()
     WHERE id = $1`,
    [id]
  )
}

/**
 * Atomic consecutive-failure counter — port of the
 * `record_webhook_failure` RPC (028). Only ever disables, never
 * re-enables; a successful delivery resets the counter via
 * `markWebhookEndpointDelivered`.
 */
export async function recordWebhookEndpointFailure(
  id: string,
  maxFailures: number
): Promise<void> {
  await getPool().query(
    `UPDATE webhook_endpoints
     SET failure_count = failure_count + 1,
         is_active = CASE WHEN failure_count + 1 >= $2 THEN false ELSE is_active END
     WHERE id = $1`,
    [id, maxFailures]
  )
}

export interface BypassEndpointSecret {
  id: string
  account_id: string
  secret: string
}

/** Every first-party (bypass_ssrf) endpoint and its encrypted secret. */
export async function listBypassEndpointSecrets(): Promise<BypassEndpointSecret[]> {
  const { rows } = await getPool().query<BypassEndpointSecret>(
    `SELECT id, account_id, secret
     FROM webhook_endpoints
     WHERE bypass_ssrf = true`
  )
  return rows
}
