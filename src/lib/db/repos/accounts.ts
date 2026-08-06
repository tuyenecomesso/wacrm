import { getPool } from '@/lib/pg'

export interface AccountRow {
  id: string
  name: string
  owner_user_id: string | null
  default_currency: string
}

export interface CreateAccountInput {
  id: string
  name: string
  ownerUserId: string
  defaultCurrency?: string
}

export interface UpdateAccountSettingsInput {
  name?: string
  defaultCurrency?: string
  ownerUserId?: string
}

const ACCOUNT_COLUMNS =
  'id, name, owner_user_id, default_currency'

export async function getAccountById(
  accountId: string,
): Promise<AccountRow | null> {
  const { rows } = await getPool().query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
       FROM accounts
      WHERE id = $1
      LIMIT 1`,
    [accountId],
  )
  return rows[0] ?? null
}

export async function getAccountNameById(
  accountId: string,
): Promise<string | null> {
  return (await getAccountById(accountId))?.name ?? null
}

export async function getAccountOwnerUserId(
  accountId: string,
): Promise<string | null> {
  return (await getAccountById(accountId))?.owner_user_id ?? null
}

export async function createAccount(
  input: CreateAccountInput,
): Promise<AccountRow> {
  const { rows } = await getPool().query<AccountRow>(
    `INSERT INTO accounts (id, name, owner_user_id, default_currency)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      input.id,
      input.name,
      input.ownerUserId,
      input.defaultCurrency ?? 'USD',
    ],
  )
  return rows[0]
}

export async function updateAccountSettings(
  accountId: string,
  input: UpdateAccountSettingsInput,
): Promise<AccountRow | null> {
  const updates: string[] = []
  const params: unknown[] = [accountId]

  if (input.name !== undefined) {
    params.push(input.name)
    updates.push(`name = $${params.length}`)
  }
  if (input.defaultCurrency !== undefined) {
    params.push(input.defaultCurrency)
    updates.push(`default_currency = $${params.length}`)
  }
  if (input.ownerUserId !== undefined) {
    params.push(input.ownerUserId)
    updates.push(`owner_user_id = $${params.length}`)
  }

  if (updates.length === 0) {
    return getAccountById(accountId)
  }

  const { rows } = await getPool().query<AccountRow>(
    `UPDATE accounts
        SET ${updates.join(', ')},
            updated_at = now()
      WHERE id = $1
      RETURNING ${ACCOUNT_COLUMNS}`,
    params,
  )
  return rows[0] ?? null
}
