import { NextResponse } from 'next/server'

import {
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import {
  removeAccountMember,
  setMemberRole,
} from '@/lib/db/repos/members'
import { isAccountRole } from '@/lib/auth/roles'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

function functionErrorToResponse(error: unknown, fallback: string): NextResponse {
  const code = (error as { code?: string }).code
  const message = error instanceof Error ? error.message : fallback
  if (code === '42501') {
    return NextResponse.json({ error: message }, { status: 403 })
  }
  if (code === '22023') {
    return NextResponse.json({ error: message }, { status: 400 })
  }
  console.error('[account members] unexpected function error:', error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const limit = checkRateLimit(
      `admin:memberRole:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { userId } = await params
    const body = (await request.json().catch(() => null)) as { role?: unknown } | null
    const role = body?.role
    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 }
      )
    }
    if (role === 'owner') {
      return NextResponse.json(
        { error: 'Use POST /api/account/transfer-ownership to promote a member to owner' },
        { status: 400 }
      )
    }
    if (!ctx.actingUserId) {
      return NextResponse.json(
        { error: 'Role changes require an API key tied to an account member' },
        { status: 403 }
      )
    }

    try {
      await setMemberRole(ctx.accountId, userId, role, ctx.actingUserId)
    } catch (error) {
      return functionErrorToResponse(error, 'Failed to update member')
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { userId } = await params
    if (!ctx.actingUserId) {
      return NextResponse.json(
        { error: 'Member removal requires an API key tied to an account member' },
        { status: 403 }
      )
    }

    try {
      return NextResponse.json({
        ok: true,
        newPersonalAccountId: await removeAccountMember(
          ctx.accountId,
          userId,
          ctx.actingUserId
        ),
      })
    } catch (error) {
      return functionErrorToResponse(error, 'Failed to update member')
    }
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
