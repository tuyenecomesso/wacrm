import { NextResponse } from 'next/server'

import {
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import { getPool } from '@/lib/pg'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const { rowCount } = await getPool().query(
      `DELETE FROM account_invitations
        WHERE id = $1
          AND account_id = $2`,
      [id, ctx.accountId]
    )
    if (!rowCount) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
