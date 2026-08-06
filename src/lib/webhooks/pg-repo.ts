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
  name: string | null
  secret: string
  events: string[]
  bypassSsrf: boolean
  createdBy?: string | null
}): Promise<WebhookEndpointRow> {
  const { rows } = await getPool().query<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints (account_id, created_by, url, name, secret, events, bypass_ssrf)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ROW_COLUMNS}`,
    [
      input.accountId,
      input.createdBy ?? null,
      input.url,
      input.name,
      input.secret,
      input.events,
      input.bypassSsrf,
    ]
  )
  return rows[0]
}

export async function listWebhookEndpointsByAccount(
  accountId: string
): Promise<WebhookEndpointRow[]> {
  const { rows } = await getPool().query<WebhookEndpointRow>(
    `SELECT ${ROW_COLUMNS}
     FROM webhook_endpoints
     WHERE account_id = $1
     ORDER BY created_at DESC`,
    [accountId]
  )
  return rows
}

export async function getWebhookEndpointById(
  accountId: string,
  id: string
): Promise<WebhookEndpointRow | null> {
  const { rows } = await getPool().query<WebhookEndpointRow>(
    `SELECT ${ROW_COLUMNS}
     FROM webhook_endpoints
     WHERE account_id = $1 AND id = $2
     LIMIT 1`,
    [accountId, id]
  )
  return rows[0] ?? null
}

export async function getWebhookEndpointByAccountAndName(
  accountId: string,
  name: string
): Promise<WebhookEndpointRow | null> {
  const { rows } = await getPool().query<WebhookEndpointRow>(
    `SELECT ${ROW_COLUMNS}
     FROM webhook_endpoints
     WHERE account_id = $1 AND name = $2 AND bypass_ssrf = true
     LIMIT 1`,
    [accountId, name]
  )
  return rows[0] ?? null
}

export async function updateWebhookEndpoint(
  accountId: string,
  id: string,
  updates: {
    url?: string
    name?: string | null
    secret?: string
    events?: string[]
    is_active?: boolean
    failure_count?: number
    bypass_ssrf?: boolean
  }
): Promise<WebhookEndpointRow | null> {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined)
  if (entries.length === 0) {
    return getWebhookEndpointById(accountId, id)
  }

  const assignments = entries.map(([key], index) => `${key} = $${index + 3}`)
  const values = [accountId, id, ...entries.map(([, value]) => value)]

  const { rows } = await getPool().query<WebhookEndpointRow>(
    `UPDATE webhook_endpoints
     SET ${assignments.join(', ')}
     WHERE account_id = $1 AND id = $2
     RETURNING ${ROW_COLUMNS}`,
    values
  )
  return rows[0] ?? null
}

export async function deleteWebhookEndpoint(
  accountId: string,
  id: string
): Promise<{ id: string } | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `DELETE FROM webhook_endpoints
     WHERE account_id = $1 AND id = $2
     RETURNING id`,
    [accountId, id]
  )
  return rows[0] ?? null
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

export async function listBypassEndpointSecrets(): Promise<BypassEndpointSecret[]> {
  const { rows } = await getPool().query<BypassEndpointSecret>(
    `SELECT id, account_id, secret
     FROM webhook_endpoints
     WHERE bypass_ssrf = true`
  )
  return rows
}
