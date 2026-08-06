import { NextResponse } from 'next/server'

import {
  getAccountRouteContext,
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import { updateAccountSettings } from '@/lib/db/repos/accounts'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

const MAX_NAME_LEN = 80

export async function GET(request: Request) {
  try {
    const ctx = await getAccountRouteContext(request)
    if (!ctx.account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    return NextResponse.json({
      account: { id: ctx.account.id, name: ctx.account.name },
      role: ctx.role ?? 'admin',
    })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const limiterId = ctx.actingUserId ?? ctx.actor.accountId
    const limit = checkRateLimit(
      `admin:rename:${limiterId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { name?: unknown } | null
    const rawName = body?.name
    if (typeof rawName !== 'string') {
      return NextResponse.json({ error: "'name' must be a string" }, { status: 400 })
    }

    const name = rawName.trim()
    if (!name) {
      return NextResponse.json({ error: 'Account name cannot be empty' }, { status: 400 })
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      )
    }

    const account = await updateAccountSettings(ctx.accountId, { name })
    if (!account) {
      return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
    }

    return NextResponse.json({ account: { id: account.id, name: account.name } })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
