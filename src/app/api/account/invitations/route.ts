import { NextResponse } from 'next/server'

import {
  requireAccountRole,
  toAccountErrorResponse,
} from '@/lib/auth/account-pg'
import {
  clampExpiryDays,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
} from '@/lib/auth/invitations'
import { isAccountRole } from '@/lib/auth/roles'
import { getPool } from '@/lib/pg'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim()
  if (!raw) return null
  const list = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  return list.length > 0 ? list : null
}

function isHostAllowed(hostname: string, allowList: readonly string[] | null): boolean {
  if (!allowList) return true
  return allowList.includes(hostname.toLowerCase())
}

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const allowList = parseAllowedHosts()
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || 'https'}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.trim()
  if (host && isHostAllowed(host, allowList)) {
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  if (allowList && (forwardedHost || host)) {
    console.warn('[POST /api/account/invitations] rejected non-allow-listed host:', {
      forwardedHost,
      host,
      allowList,
    })
  } else {
    console.warn(
      '[POST /api/account/invitations] could not derive base URL from request; falling back to marketing domain'
    )
  }
  return 'https://wacrm.tech'
}

const MAX_LABEL_LEN = 80

export async function GET(request: Request) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const { rows } = await getPool().query<Record<string, unknown>>(
      `SELECT id, role, label, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id
         FROM account_invitations
        WHERE account_id = $1
          AND accepted_at IS NULL
          AND expires_at > $2
        ORDER BY created_at DESC`,
      [ctx.accountId, new Date().toISOString()]
    )
    return NextResponse.json({ invitations: rows })
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAccountRole(request, 'admin')
    const limit = checkRateLimit(
      `admin:inviteCreate:${ctx.actingUserId ?? ctx.accountId}`,
      RATE_LIMITS.adminAction
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; expiresInDays?: unknown; label?: unknown }
      | null

    const role = body?.role
    if (!isAccountRole(role) || role === 'owner') {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 }
      )
    }

    const expiresInDays =
      typeof body?.expiresInDays === 'number' ? body.expiresInDays : undefined
    const expiryDays = clampExpiryDays(expiresInDays)
    const expiresAt = inviteExpiresAt(expiryDays)

    let label: string | null = null
    if (typeof body?.label === 'string') {
      const trimmed = body.label.trim()
      if (trimmed.length > MAX_LABEL_LEN) {
        return NextResponse.json(
          { error: `Label must be ${MAX_LABEL_LEN} characters or fewer` },
          { status: 400 }
        )
      }
      label = trimmed || null
    }

    const { token, hash } = generateInviteToken()
    const { rows } = await getPool().query<Record<string, unknown>>(
      `INSERT INTO account_invitations
         (account_id, token_hash, role, created_by_user_id, label, expires_at)
       VALUES ($1, $2, $3::account_role_enum, $4, $5, $6)
       RETURNING id, role, label, expires_at, created_at`,
      [ctx.accountId, hash, role, ctx.actingUserId, label, expiresAt.toISOString()]
    )

    return NextResponse.json(
      {
        invitation: rows[0],
        token,
        url: inviteUrl(token, getBaseUrl(request)),
        expiresInDays: expiryDays,
      },
      { status: 201 }
    )
  } catch (error) {
    return toAccountErrorResponse(error)
  }
}
