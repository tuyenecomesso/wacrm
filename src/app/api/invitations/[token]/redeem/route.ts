// ============================================================
// POST /api/invitations/[token]/redeem
//
// Bearer-authenticated. The caller identity comes from the API key's
// `created_by` user, then the direct-PG `redeem_invitation(token_hash,
// user_id)` function atomically moves that user into the invited
// account.
//
// Refusal contract (from the SQL function)
//   - SQLSTATE 42501 -> 401/403 (unauthorized / no acting user)
//   - SQLSTATE 22023 -> 400 (invitation not_found / used / expired)
//   - SQLSTATE 23505 -> 409 (caller already has account data / already
//     belongs to this or another shared account)
// ============================================================

import { NextResponse } from 'next/server'

import { hashInviteToken } from '@/lib/auth/invitations'
import { requireApiKey } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

function sqlStateToResponse(code: string | undefined, message: string): NextResponse {
  if (code === '42501') {
    return NextResponse.json({ error: message }, { status: 401 })
  }
  if (code === '22023') {
    return NextResponse.json({ error: message }, { status: 400 })
  }
  if (code === '23505') {
    return NextResponse.json({ error: message }, { status: 409 })
  }
  console.error('[redeem] unexpected SQL error:', { code, message })
  return NextResponse.json(
    { error: 'Failed to redeem invitation' },
    { status: 500 },
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(request)
  const limit = checkRateLimit(`redeem:${ip}`, RATE_LIMITS.invitationRedeem)
  if (!limit.success) return rateLimitResponse(limit)

  const { token } = await params
  if (!token || typeof token !== 'string') {
    return NextResponse.json(
      { error: 'Missing invitation token' },
      { status: 400 },
    )
  }

  try {
    const actor = await requireApiKey(request)
    if (!actor.createdBy) {
      return NextResponse.json(
        { error: 'This API key is not bound to a redeemable user' },
        { status: 403 },
      )
    }

    const { rows } = await getPool().query<{ redeem_invitation: string }>(
      'SELECT redeem_invitation($1, $2) AS redeem_invitation',
      [hashInviteToken(token), actor.createdBy],
    )

    return NextResponse.json({
      ok: true,
      accountId: rows[0]?.redeem_invitation ?? null,
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    const message =
      error instanceof Error ? error.message : 'Failed to redeem invitation'
    return sqlStateToResponse(code, message)
  }
}
