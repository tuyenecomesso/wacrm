import { NextResponse } from 'next/server'

import { hashInviteToken } from '@/lib/auth/invitations'
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const ip = getClientIp(request)
  const limit = checkRateLimit(`peek:${ip}`, RATE_LIMITS.invitationPeek)
  if (!limit.success) return rateLimitResponse(limit)

  const { token } = await params
  if (!token || typeof token !== 'string') {
    return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 })
  }

  try {
    const { rows } = await getPool().query<{ peek_invitation: unknown }>(
      'SELECT peek_invitation($1)',
      [hashInviteToken(token)]
    )
    return NextResponse.json(rows[0]?.peek_invitation ?? { ok: false, reason: 'not_found' })
  } catch (error) {
    console.error('[peek] function error:', error)
    return NextResponse.json({ ok: false, reason: 'server_error' }, { status: 500 })
  }
}
