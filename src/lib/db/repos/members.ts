import { getPool } from '@/lib/pg'

import { type AccountRole, isAccountRole } from '@/lib/auth/roles'
import { withAccountClause } from './with-account'

export interface AccountMemberRow {
  user_id: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
  account_role: AccountRole
  created_at: string
}

export async function listAccountMembers(
  accountId: string,
): Promise<AccountMemberRow[]> {
  const scoped = withAccountClause(accountId)
  const { rows } = await getPool().query<{
    user_id: string
    full_name: string | null
    email: string | null
    avatar_url: string | null
    account_role: string
    created_at: string
  }>(
    `SELECT user_id, full_name, email, avatar_url, account_role, created_at
       FROM profiles
      WHERE ${scoped.sql}
      ORDER BY created_at ASC`,
    [...scoped.params],
  )

  return rows.flatMap((row) =>
    isAccountRole(row.account_role)
      ? [{ ...row, account_role: row.account_role }]
      : [],
  )
}

export async function getMemberRole(
  accountId: string,
  userId: string,
): Promise<AccountRole | null> {
  const scoped = withAccountClause(accountId, [userId])
  const { rows } = await getPool().query<{ account_role: string }>(
    `SELECT account_role
       FROM profiles
      WHERE user_id = $1
        AND ${scoped.sql}
      LIMIT 1`,
    [...scoped.params],
  )

  const role = rows[0]?.account_role
  return isAccountRole(role) ? role : null
}

export async function setMemberRole(
  accountId: string,
  userId: string,
  role: Exclude<AccountRole, 'owner'>,
  actingUserId: string,
): Promise<void> {
  await getPool().query(
    'SELECT set_member_role($1, $2, $3, $4)',
    [accountId, userId, role, actingUserId],
  )
}

export async function removeAccountMember(
  accountId: string,
  userId: string,
  actingUserId: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ remove_account_member: string | null }>(
    'SELECT remove_account_member($1, $2, $3)',
    [accountId, userId, actingUserId],
  )
  return rows[0]?.remove_account_member ?? null
}

export async function transferAccountOwnership(
  accountId: string,
  newOwnerUserId: string,
  actingUserId: string,
): Promise<void> {
  await getPool().query(
    'SELECT transfer_account_ownership($1, $2, $3)',
    [accountId, newOwnerUserId, actingUserId],
  )
}
