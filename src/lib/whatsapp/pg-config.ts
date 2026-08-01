import { getPool } from '@/lib/pg'

export interface WhatsappConfigRow {
  id: string
  account_id: string
  user_id: string | null
  phone_number_id: string | null
  waba_id: string | null
  access_token: string | null
  verify_token: string | null
  status: string | null
  connected_at: string | null
  registered_at: string | null
  subscribed_apps_at: string | null
  last_registration_error: string | null
  created_at: string
  updated_at: string
}

export interface WhatsappConfigInput {
  phone_number_id: string
  waba_id?: string | null
  access_token: string
  verify_token?: string | null
  status: string
  connected_at?: string | null
  registered_at?: string | null
  subscribed_apps_at?: string | null
  last_registration_error?: string | null
}

const ROW_COLUMNS =
  'id, account_id, user_id, phone_number_id, waba_id, access_token, verify_token, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, created_at, updated_at'

export async function getConfigByAccount(
  accountId: string
): Promise<WhatsappConfigRow | null> {
  const { rows } = await getPool().query<WhatsappConfigRow>(
    `SELECT ${ROW_COLUMNS} FROM whatsapp_config WHERE account_id = $1 LIMIT 1`,
    [accountId]
  )
  return rows[0] ?? null
}

export async function getClaimedAccountByPhoneNumber(
  phoneNumberId: string,
  excludeAccountId: string
): Promise<string | null> {
  const { rows } = await getPool().query<{ account_id: string }>(
    `SELECT account_id FROM whatsapp_config
     WHERE phone_number_id = $1 AND account_id <> $2
     LIMIT 1`,
    [phoneNumberId, excludeAccountId]
  )
  return rows[0]?.account_id ?? null
}

/**
 * Insert-or-update the account's single WhatsApp config row
 * (one row per account; `account_id` is UNIQUE).
 */
export async function saveConfigForAccount(
  accountId: string,
  userId: string | null,
  input: WhatsappConfigInput
): Promise<void> {
  const existing = await getConfigByAccount(accountId)

  if (existing) {
    await getPool().query(
      `UPDATE whatsapp_config SET
         phone_number_id = $1,
         waba_id = $2,
         access_token = $3,
         verify_token = $4,
         status = $5,
         connected_at = $6,
         registered_at = $7,
         subscribed_apps_at = $8,
         last_registration_error = $9,
         updated_at = now()
       WHERE account_id = $10`,
      [
        input.phone_number_id,
        input.waba_id ?? null,
        input.access_token,
        input.verify_token ?? null,
        input.status,
        input.connected_at ?? null,
        input.registered_at ?? null,
        input.subscribed_apps_at ?? null,
        input.last_registration_error ?? null,
        accountId,
      ]
    )
    return
  }

  await getPool().query(
    `INSERT INTO whatsapp_config
       (account_id, user_id, phone_number_id, waba_id, access_token, verify_token,
        status, connected_at, registered_at, subscribed_apps_at, last_registration_error,
        updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
    [
      accountId,
      userId,
      input.phone_number_id,
      input.waba_id ?? null,
      input.access_token,
      input.verify_token ?? null,
      input.status,
      input.connected_at ?? null,
      input.registered_at ?? null,
      input.subscribed_apps_at ?? null,
      input.last_registration_error ?? null,
    ]
  )
}

export async function deleteConfigByAccount(accountId: string): Promise<void> {
  await getPool().query('DELETE FROM whatsapp_config WHERE account_id = $1', [accountId])
}
