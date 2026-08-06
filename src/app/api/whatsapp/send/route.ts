import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { getPool } from '@/lib/pg'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'messages:send')
    const actorId = actor.authType === 'api_key' ? actor.keyId : actor.endpointId

    const limit = checkRateLimit(`send:${actorId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error: 'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 },
      )
    }

    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    let conversationId: string | null = null
    const pool = getPool()

    if (conversationIdInput) {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id
         FROM conversations
         WHERE id = $1
           AND account_id = $2
         LIMIT 1`,
        [conversationIdInput, actor.accountId],
      )
      conversationId = rows[0]?.id ?? null
      if (!conversationId) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
    } else {
      const { rows: contactRows } = await pool.query<{ id: string }>(
        `SELECT id
         FROM contacts
         WHERE id = $1
           AND account_id = $2
         LIMIT 1`,
        [contact_id, actor.accountId],
      )
      if (!contactRows[0]) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }

      const auditUserId = await resolveAuditUserId(actor.accountId)
      conversationId = await findOrCreateConversation(
        actor.accountId,
        auditUserId,
        String(contact_id),
      )

      if (!conversationId) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 },
        )
      }
    }

    const result = await sendMessageToConversation(actor.accountId, {
      conversationId,
      messageType: message_type,
      contentText: content_text,
      mediaUrl: media_url,
      filename,
      templateName: template_name,
      templateLanguage: template_language,
      templateParams: template_params,
      templateMessageParams: template_message_params,
      interactivePayload: interactive_payload,
      replyToMessageId: reply_to_message_id,
    })

    return NextResponse.json({
      success: true,
      message_id: result.messageId,
      whatsapp_message_id: result.whatsappMessageId,
    })
  } catch (error) {
    if (error instanceof SendMessageError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}

async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const pool = getPool()

  const { rows: existingRows } = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversations
     WHERE account_id = $1
       AND contact_id = $2
     LIMIT 1`,
    [accountId, contactId],
  )

  if (existingRows[0]) return existingRows[0].id

  try {
    const { rows: createdRows } = await pool.query<{ id: string }>(
      `INSERT INTO conversations (account_id, user_id, contact_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [accountId, userId, contactId],
    )
    return createdRows[0]?.id ?? null
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id
         FROM conversations
         WHERE account_id = $1
           AND contact_id = $2
         LIMIT 1`,
        [accountId, contactId],
      )
      return rows[0]?.id ?? null
    }
    console.error('Error creating conversation for contact send:', error)
    return null
  }
}
