import { NextResponse, after } from 'next/server'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { getPool } from '@/lib/pg'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import {
  listConfigVerifyTokens,
  listConfigsForPhoneNumber,
  updateVerifyTokenById,
} from '@/lib/whatsapp/pg-config'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const configs = await listConfigVerifyTokens()
    if (!configs) {
      console.error('Error fetching configs for verification')
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void updateVerifyTokenById(matchedConfig.id, encrypt(verifyToken)).catch((error: unknown) => {
          console.warn(
            '[webhook] verify_token GCM upgrade failed:',
            error instanceof Error ? error.message : error,
          )
        })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange({
          field: change.field,
          value: change.value as unknown,
        })
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const configRows = await listConfigsForPhoneNumber(phoneNumberId)

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r) => `${r.account_id} (admin ${r.user_id ?? 'unknown'})`)
        )
        continue
      }

      const config = configRows[0]
      if (!config?.access_token || !config.account_id || !config.user_id) {
        console.error('Incomplete config found for phone_number_id:', phoneNumberId)
        continue
      }

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          decryptedAccessToken
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  try {
    await getPool().query(
      `UPDATE messages
       SET status = $2
       WHERE message_id = $1`,
      [status.id, status.status]
    )
  } catch (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  let recipient: { id: string; status: string } | null = null
  try {
    const { rows } = await getPool().query<{ id: string; status: string }>(
      `SELECT id, status
       FROM broadcast_recipients
       WHERE whatsapp_message_id = $1
       LIMIT 1`,
      [status.id]
    )
    recipient = rows[0] ?? null
  } catch (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  }

  if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    try {
      await getPool().query(
        `UPDATE broadcast_recipients
         SET status = $2,
             sent_at = COALESCE($3, sent_at),
             delivered_at = COALESCE($4, delivered_at),
             read_at = COALESCE($5, read_at)
         WHERE id = $1`,
        [
          recipient.id,
          update.status,
          update.sent_at ?? null,
          update.delivered_at ?? null,
          update.read_at ?? null,
        ]
      )
    } catch (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { rows: msgRows } = await getPool().query<{
    conversation_id: string
    account_id: string
  }>(
    `SELECT m.conversation_id, c.account_id
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.message_id = $1
     LIMIT 1`,
    [status.id]
  )
  const msgRow = msgRows[0]

  if (msgRow) {
    const accountId = msgRow.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT br.id
       FROM broadcast_recipients br
       JOIN broadcasts b ON b.id = br.broadcast_id
       WHERE br.contact_id = $1
         AND b.account_id = $2
         AND br.status = ANY($3::text[])
       ORDER BY br.created_at DESC
       LIMIT 1`,
      [contactId, accountId, ['sent', 'delivered', 'read']]
    )
    const row = rows[0]
    if (!row) return

    await getPool().query(
      `UPDATE broadcast_recipients
       SET status = 'replied',
           replied_at = $2
       WHERE id = $1`,
      [row.id, new Date().toISOString()]
    )
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id
       FROM messages
       WHERE message_id = $1
         AND conversation_id = $2
       LIMIT 1`,
      [metaId, conversationId]
    )
    return rows[0]?.id ?? null
  } catch (error) {
    console.error(
      '[webhook] lookupInternalIdByMetaId failed:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    try {
      await getPool().query(
        `DELETE FROM message_reactions
         WHERE message_id = $1
           AND actor_type = 'customer'
           AND actor_id = $2`,
        [targetInternalId, contactId]
      )
    } catch (error) {
      console.error(
        '[webhook] reaction delete failed:',
        error instanceof Error ? error.message : error
      )
    }
    return
  }

  try {
    await getPool().query(
      `INSERT INTO message_reactions
         (message_id, conversation_id, actor_type, actor_id, emoji)
       VALUES ($1, $2, 'customer', $3, $4)
       ON CONFLICT (message_id, actor_type, actor_id)
       DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         emoji = EXCLUDED.emoji`,
      [targetInternalId, conversationId, contactId, reaction.emoji]
    )
  } catch (error) {
    console.error(
      '[webhook] reaction upsert failed:',
      error instanceof Error ? error.message : error
    )
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name
  const client = await getPool().connect()

  try {
    await client.query('BEGIN')
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [accountId, senderPhone]
    )

    const contactOutcome = await findOrCreateContact(
      client,
      accountId,
      configOwnerUserId,
      senderPhone,
      contactName
    )
    if (!contactOutcome) {
      await client.query('ROLLBACK')
      return
    }
    const contactRecord = contactOutcome.contact

    const convResult = await findOrCreateConversation(
      client,
      accountId,
      configOwnerUserId,
      contactRecord.id
    )
    if (!convResult) {
      await client.query('ROLLBACK')
      return
    }
    const conversation = convResult.conversation

    if (message.type === 'reaction') {
      await client.query('COMMIT')
      if (convResult.created) {
        await dispatchWebhookEvent(accountId, 'conversation.created', {
          conversation_id: conversation.id,
          contact_id: contactRecord.id,
          wa_id: senderPhone,
          contact_name: contactName,
        })
      }
      await handleReaction(message, conversation.id, contactRecord.id)
      return
    }

    const { contentText, mediaUrl, mediaType, interactiveReplyId } =
      await parseMessageContent(message, accessToken)

    let replyToInternalId: string | null = null
    if (message.context?.id) {
      replyToInternalId = await lookupInternalIdByMetaId(
        message.context.id,
        conversation.id
      )
      if (!replyToInternalId) {
        console.warn('[webhook] reply context parent not found:', message.context.id)
      }
    }

    void mediaType

    const allowedContentTypes = new Set([
      'text', 'image', 'document', 'audio', 'video',
      'location', 'template', 'interactive',
    ])
    const contentType = allowedContentTypes.has(message.type)
      ? message.type
      : message.type === 'sticker'
        ? 'image'
        : 'text'

    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM messages
       WHERE conversation_id = $1
         AND sender_type = 'customer'`,
      [conversation.id]
    )
    const isFirstInboundMessage = Number(countRows[0]?.count ?? '0') === 0

    const { rows: insertedMessageRows } = await client.query<{ id: string }>(
      `INSERT INTO messages
         (conversation_id, sender_type, content_type, content_text, media_url,
          message_id, status, created_at, reply_to_message_id, interactive_reply_id)
       VALUES ($1, 'customer', $2, $3, $4, $5, 'delivered', $6, $7, $8)
       ON CONFLICT (conversation_id, message_id)
         WHERE message_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        conversation.id,
        contentType,
        contentText,
        mediaUrl,
        message.id,
        new Date(parseInt(message.timestamp) * 1000).toISOString(),
        replyToInternalId,
        interactiveReplyId,
      ]
    )

    if (!insertedMessageRows[0]) {
      await client.query('COMMIT')
      return
    }

    await client.query(
      `UPDATE conversations
       SET last_message_text = $2,
           last_message_at = $3,
           unread_count = $4,
           updated_at = $5
       WHERE id = $1`,
      [
        conversation.id,
        contentText || `[${message.type}]`,
        new Date().toISOString(),
        (conversation.unread_count || 0) + 1,
        new Date().toISOString(),
      ]
    )

    await client.query('COMMIT')

    if (convResult.created) {
      await dispatchWebhookEvent(accountId, 'conversation.created', {
        conversation_id: conversation.id,
        contact_id: contactRecord.id,
        wa_id: senderPhone,
        contact_name: contactName,
      })
    }

    await flagBroadcastReplyIfAny(accountId, contactRecord.id)

    // The first-party webhook is the external source of truth for
    // inbound-message fan-out; it must not be skipped just because an
    // optional downstream engine (Flows / AI) throws afterwards.
    await dispatchWebhookEvent(accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      whatsapp_message_id: message.id,
      content_type: contentType,
      text: contentText,
      wa_id: senderPhone,
      contact_name: contactName,
    })

    let flowConsumed = false
    try {
      const flowResult = await dispatchInboundToFlows({
        accountId,
        userId: configOwnerUserId,
        contactId: contactRecord.id,
        conversationId: conversation.id,
        message:
          interactiveReplyId
            ? {
                kind: 'interactive_reply',
                reply_id: interactiveReplyId,
                reply_title: contentText ?? '',
                meta_message_id: message.id,
              }
            : {
                kind: 'text',
                text: contentText ?? message.text?.body ?? '',
                meta_message_id: message.id,
              },
        isFirstInboundMessage,
      })
      flowConsumed = flowResult.consumed
    } catch (error) {
      console.error(
        '[webhook] flow dispatch failed:',
        error instanceof Error ? error.message : error
      )
    }

    const inboundText = contentText ?? message.text?.body ?? ''
    const automationTriggers: (
      | 'new_contact_created'
      | 'first_inbound_message'
      | 'new_message_received'
      | 'keyword_match'
      | 'interactive_reply'
    )[] = []
    if (!flowConsumed) {
      automationTriggers.push('new_message_received', 'keyword_match')
      if (interactiveReplyId) {
        automationTriggers.push('interactive_reply')
      }
    }
    if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
    if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
    for (const triggerType of automationTriggers) {
      runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id,
        context: {
          message_text: inboundText,
          conversation_id: conversation.id,
          interactive_reply_id: interactiveReplyId ?? undefined,
        },
      }).catch((err) => console.error('[automations] dispatch failed:', err))
    }

    if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
      try {
        await dispatchInboundToAiReply({
          accountId,
          conversationId: conversation.id,
          contactId: contactRecord.id,
          configOwnerUserId,
        })
      } catch (error) {
        console.error(
          '[webhook] AI auto-reply dispatch failed:',
          error instanceof Error ? error.message : error
        )
      }
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('Error processing message:', error)
  } finally {
    client.release()
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

interface ContactRow {
  id: string
  phone: string
  name: string | null
}

interface ConversationRow {
  id: string
  unread_count: number | null
}

interface Queryable {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  db: Queryable,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) return null

  try {
    const { rows } = await db.query<
      ContactRow & { inserted: boolean }
    >(
      `INSERT INTO contacts (account_id, user_id, phone, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, phone_normalized)
         WHERE phone_normalized <> ''
       DO UPDATE
          SET name = CASE
                       WHEN EXCLUDED.name IS NOT NULL
                        AND EXCLUDED.name <> ''
                        AND EXCLUDED.name IS DISTINCT FROM contacts.name
                       THEN EXCLUDED.name
                       ELSE contacts.name
                     END,
              updated_at = CASE
                             WHEN EXCLUDED.name IS NOT NULL
                              AND EXCLUDED.name <> ''
                              AND EXCLUDED.name IS DISTINCT FROM contacts.name
                             THEN NOW()
                             ELSE contacts.updated_at
                           END
       RETURNING id,
                 phone,
                 name,
                 (xmax = 0) AS inserted`,
      [accountId, configOwnerUserId, normalizedPhone, name || normalizedPhone],
    )
    const row = rows[0]
    if (!row) return null
    return {
      contact: { id: row.id, phone: row.phone, name: row.name },
      wasCreated: row.inserted,
    }
  } catch (createError) {
    if (isUniqueViolation(createError)) {
      const { rows: racedRows } = await db.query<ContactRow>(
        `SELECT id, phone, name
         FROM contacts
         WHERE account_id = $1
           AND phone_normalized = $2
         LIMIT 1`,
        [accountId, normalizedPhone]
      )
      const raced = racedRows[0]
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }
}

async function findOrCreateConversation(
  db: Queryable,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  try {
    const { rows } = await db.query<
      ConversationRow & { inserted: boolean }
    >(
      `INSERT INTO conversations (account_id, user_id, contact_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, contact_id)
       DO UPDATE
          SET updated_at = conversations.updated_at
       RETURNING id,
                 unread_count,
                 (xmax = 0) AS inserted`,
      [accountId, configOwnerUserId, contactId]
    )
    const row = rows[0]
    if (!row) return null
    return {
      conversation: { id: row.id, unread_count: row.unread_count },
      created: row.inserted,
    }
  } catch (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }
}
