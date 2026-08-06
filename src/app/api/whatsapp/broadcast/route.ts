import { after, NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import {
  createBroadcast,
  deliverBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const maxDuration = 60

interface LegacyRecipient {
  phone: string
  params?: string[]
}

function normalizeRecipients(body: Record<string, unknown>): LegacyRecipient[] {
  if (Array.isArray(body.recipients) && body.recipients.length > 0) {
    return body.recipients.map((recipient) => ({
      phone: typeof recipient?.phone === 'string'
        ? recipient.phone
        : typeof recipient?.to === 'string'
          ? recipient.to
          : '',
      params: Array.isArray(recipient?.params)
        ? recipient.params.filter((value: unknown): value is string => typeof value === 'string')
        : undefined,
    }))
  }

  if (Array.isArray(body.phone_numbers) && body.phone_numbers.length > 0) {
    const shared = Array.isArray(body.template_params)
      ? body.template_params.filter((value: unknown): value is string => typeof value === 'string')
      : []
    return body.phone_numbers.map((phone) => ({
      phone: typeof phone === 'string' ? phone : '',
      params: shared,
    }))
  }

  return []
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'broadcasts:send')
    const actorId = actor.authType === 'api_key' ? actor.keyId : actor.endpointId

    const limit = checkRateLimit(`broadcast:${actorId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const recipients = normalizeRecipients(body)
    if (recipients.length === 0) {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` - must be a non-empty array',
        },
        { status: 400 },
      )
    }

    const auditUserId = await resolveAuditUserId(actor.accountId)
    const templateName =
      typeof body.template_name === 'string' ? body.template_name : ''

    const plan = await createBroadcast(actor.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      recipients: recipients.map((recipient) => ({
        to: recipient.phone,
        params: recipient.params,
      })),
    })

    after(() => deliverBroadcast(plan))

    return NextResponse.json({
      success: true,
      total: plan.planned.length + plan.rejected,
      sent: 0,
      failed: plan.rejected,
      broadcast_id: plan.broadcastId,
      accepted: plan.planned.length,
      rejected: plan.rejected,
      results: plan.planned.map((recipient) => ({
        phone: recipient.phone,
        status: 'pending',
      })),
    })
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (error instanceof ContactError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    }
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json({ error: 'Failed to process broadcast' }, { status: 500 })
  }
}
