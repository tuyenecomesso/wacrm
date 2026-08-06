import { NextResponse } from 'next/server'

import {
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import { revokeKey } from '@/lib/api-keys/store'
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
      `admin:apiKeyRevoke:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const ok = await revokeKey(ctx.accountId, id)
    if (!ok) {
      return NextResponse.json(
        { error: 'API key not found or already revoked' },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
