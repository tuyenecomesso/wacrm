import { NextResponse } from 'next/server'

import {
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import { transferAccountOwnership } from '@/lib/db/repos/members'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

function functionErrorToResponse(error: unknown): NextResponse {
  const code = (error as { code?: string }).code
  const message = error instanceof Error ? error.message : 'Failed to transfer ownership'
  if (code === '42501') {
    return NextResponse.json({ error: message }, { status: 403 })
  }
  if (code === '22023') {
    return NextResponse.json({ error: message }, { status: 400 })
  }
  console.error('[transfer-ownership] unexpected function error:', error)
  return NextResponse.json({ error: 'Failed to transfer ownership' }, { status: 500 })
}

function looksLikeUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAccountRole(request, 'owner')
    const limit = checkRateLimit(
      `admin:transferOwnership:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | { newOwnerUserId?: unknown }
      | null
    const newOwnerUserId = body?.newOwnerUserId
    if (!looksLikeUuid(newOwnerUserId)) {
      return NextResponse.json(
        { error: "'newOwnerUserId' must be a valid UUID" },
        { status: 400 }
      )
    }
    if (!ctx.actingUserId) {
      return NextResponse.json(
        { error: 'Ownership transfer requires an API key tied to the current owner' },
        { status: 403 }
      )
    }

    try {
      await transferAccountOwnership(ctx.accountId, newOwnerUserId, ctx.actingUserId)
    } catch (error) {
      return functionErrorToResponse(error)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
