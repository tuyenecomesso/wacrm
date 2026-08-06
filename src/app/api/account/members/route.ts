import { NextResponse } from 'next/server'

import { getAccountRouteContext, toAccountErrorResponse } from '@/lib/auth/account-pg'
import { listAccountMembers } from '@/lib/db/repos/members'
import type { AccountMember } from '@/types'

export async function GET(request: Request) {
  try {
    const ctx = await getAccountRouteContext(request)
    const rows = await listAccountMembers(ctx.accountId)

    const members: AccountMember[] = rows.map((row) => ({
        user_id: row.user_id,
        full_name: row.full_name ?? '',
        email: row.email,
        avatar_url: row.avatar_url,
        role: row.account_role,
        joined_at: row.created_at,
      }))

    return NextResponse.json({ members })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
