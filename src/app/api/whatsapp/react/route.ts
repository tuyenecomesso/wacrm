import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { sendReactionMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { getConfigByAccount } from '@/lib/whatsapp/pg-config'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'messages:send')
    const actorId = actor.authType === 'api_key' ? actor.keyId : actor.endpointId

    const limit = checkRateLimit(`react:${actorId}`, RATE_LIMITS.react)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const { message_id, emoji } = body as {
      message_id?: string
      emoji?: string
    }

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json({ error: 'message_id and emoji are required' }, { status: 400 })
    }

    const pool = getPool()
    const { rows: targetRows } = await pool.query<{
      id: string
      message_id: string | null
      conversation_id: string
      account_id: string
      phone: string | null
    }>(
      `SELECT
         m.id,
         m.message_id,
         m.conversation_id,
         c.account_id,
         ct.phone
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE m.id = $1
         AND c.account_id = $2
       LIMIT 1`,
      [message_id, actor.accountId],
    )

    const target = targetRows[0]
    if (!target) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }
    if (!target.message_id) {
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      )
    }
    if (!target.phone) {
      return NextResponse.json({ error: 'Contact phone number not found' }, { status: 400 })
    }

    const config = await getConfigByAccount(actor.accountId)
    if (!config?.phone_number_id || !config.access_token) {
      return NextResponse.json({ error: 'WhatsApp not configured.' }, { status: 400 })
    }

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        to: sanitizePhoneForMeta(target.phone),
        targetMessageId: target.message_id,
        emoji,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/react] Meta send failed:', message)
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 502 })
    }

    if (emoji === '') {
      await pool.query(
        `DELETE FROM message_reactions
         WHERE message_id = $1
           AND actor_type = 'agent'
           AND actor_id = $2`,
        [target.id, actorId],
      )
    } else {
      await pool.query(
        `INSERT INTO message_reactions
          (message_id, conversation_id, actor_type, actor_id, emoji)
         VALUES ($1, $2, 'agent', $3, $4)
         ON CONFLICT (message_id, actor_type, actor_id)
         DO UPDATE SET emoji = EXCLUDED.emoji`,
        [target.id, target.conversation_id, actorId, emoji],
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error)
    return NextResponse.json({ error: 'Failed to react to message' }, { status: 500 })
  }
}
