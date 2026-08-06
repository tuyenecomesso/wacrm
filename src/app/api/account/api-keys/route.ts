import { NextResponse } from 'next/server'

import {
  getAccountRouteContext,
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import { generateApiKey } from '@/lib/api-keys/keys'
import { normalizeScopes } from '@/lib/api-keys/scopes'
import { insertKey, listKeys } from '@/lib/api-keys/store'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

const MAX_NAME_LEN = 80
const MAX_EXPIRY_DAYS = 365

export async function GET(request: Request) {
  try {
    const ctx = await getAccountRouteContext(request)
    const keys = await listKeys(ctx.accountId)
    return NextResponse.json({ keys })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const limit = checkRateLimit(
      `admin:apiKeyCreate:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      name?: unknown
      scopes?: unknown
      expiresInDays?: unknown
    } | null

    const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!rawName) {
      return NextResponse.json({ error: "'name' is required" }, { status: 400 })
    }
    if (rawName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      )
    }

    const scopes = normalizeScopes(body?.scopes ?? [])
    if (scopes === null) {
      return NextResponse.json(
        { error: "'scopes' must be an array of known scope strings" },
        { status: 400 }
      )
    }

    let expiresAt: string | null = null
    const rawExpiry = body?.expiresInDays
    if (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry) && rawExpiry > 0) {
      const days = Math.min(Math.floor(rawExpiry), MAX_EXPIRY_DAYS)
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    }

    const { plaintext, hash, prefix } = generateApiKey()
    const key = await insertKey({
      accountId: ctx.accountId,
      createdBy: ctx.actingUserId,
      name: rawName,
      keyPrefix: prefix,
      keyHash: hash,
      scopes,
      expiresAt,
    })

    return NextResponse.json({ key, plaintext }, { status: 201 })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
