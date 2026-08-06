import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ conversationId: string }> }

export async function POST(request: Request, { params }: Params) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-takeover:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.send,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json({ error: 'paused (boolean) is required' }, { status: 400 })
    }

    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    const { rows: convRows } = await getPool().query<{ id: string }>(
      `SELECT id
         FROM conversations
        WHERE id = $1
          AND account_id = $2
        LIMIT 1`,
      [conversationId, actor.accountId],
    )
    if (convRows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const updates: string[] = ['ai_autoreply_disabled = $3']
    const values: unknown[] = [conversationId, actor.accountId, paused]

    if (paused) {
      if (assignToMe) {
        updates.push(`assigned_agent_id = $${values.length + 1}`)
        values.push(actor.authType === 'api_key' ? actor.createdBy : null)
      }
    } else {
      updates.push(`assigned_agent_id = $${values.length + 1}`)
      values.push(null)
      updates.push(`ai_reply_count = $${values.length + 1}`)
      values.push(0)
      updates.push(`ai_handoff_summary = $${values.length + 1}`)
      values.push(null)
    }

    await getPool().query(
      `UPDATE conversations
          SET ${updates.join(', ')}
        WHERE id = $1
          AND account_id = $2`,
      values,
    )

    return NextResponse.json({ success: true, paused })
  } catch (error) {
    console.error('[ai/autoreply] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
