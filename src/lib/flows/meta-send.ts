import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { getPool } from '@/lib/pg'
import { getConfigByAccount } from '@/lib/whatsapp/pg-config'

interface SendTextEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  aiGenerated?: boolean
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function loadContact(
  accountId: string,
  contactId: string,
): Promise<{ id: string; phone: string } | null> {
  const { rows } = await getPool().query<{ id: string; phone: string }>(
    `SELECT id, phone
       FROM contacts
      WHERE id = $1
        AND account_id = $2
      LIMIT 1`,
    [contactId, accountId],
  )
  return rows[0] ?? null
}

async function updateContactPhone(contactId: string, phone: string): Promise<void> {
  await getPool().query(
    `UPDATE contacts
        SET phone = $2
      WHERE id = $1`,
    [contactId, phone],
  )
}

async function insertMessage(params: {
  conversationId: string
  contentType: string
  contentText: string | null
  messageId: string
  interactivePayload?: InteractiveMessagePayload | null
  aiGenerated?: boolean
}): Promise<void> {
  await getPool().query(
    `INSERT INTO messages (
       conversation_id,
       sender_type,
       content_type,
       content_text,
       interactive_payload,
       message_id,
       status,
       ai_generated
     ) VALUES ($1, 'bot', $2, $3, $4::jsonb, $5, 'sent', $6)`,
    [
      params.conversationId,
      params.contentType,
      params.contentText,
      params.interactivePayload ? JSON.stringify(params.interactivePayload) : null,
      params.messageId,
      params.aiGenerated ?? false,
    ],
  )
}

async function touchConversation(conversationId: string, preview: string): Promise<void> {
  const now = new Date().toISOString()
  await getPool().query(
    `UPDATE conversations
        SET last_message_text = $2,
            last_message_at = $3,
            updated_at = $3
      WHERE id = $1`,
    [conversationId, preview, now],
  )
}

async function resolveChannel(accountId: string, contactId: string): Promise<{
  contact: { id: string; phone: string }
  phoneNumberId: string
  accessToken: string
}> {
  const contact = await loadContact(accountId, contactId)
  if (!contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const config = await getConfigByAccount(accountId)
  if (!config?.phone_number_id || !config.access_token) {
    throw new Error('WhatsApp not configured for this account')
  }

  return {
    contact,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  }
}

export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { contact, phoneNumberId, accessToken } = await resolveChannel(
    args.accountId,
    args.contactId,
  )

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const attempt = async (phone: string): Promise<string> => {
    const result = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      text: args.text,
    })
    return result.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      waMessageId = await attempt(variant)
      workingPhone = variant
      lastError = null
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isRecipientNotAllowedError(message)) throw error
      lastError = error
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await updateContactPhone(contact.id, workingPhone)
  }

  await insertMessage({
    conversationId: args.conversationId,
    contentType: 'text',
    contentText: args.text,
    messageId: waMessageId,
    aiGenerated: args.aiGenerated,
  })
  await touchConversation(args.conversationId, args.text)

  return { whatsapp_message_id: waMessageId }
}

export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { contact, phoneNumberId, accessToken } = await resolveChannel(
    args.accountId,
    args.contactId,
  )

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const attempt = async (phone: string): Promise<string> => {
    const result = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return result.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      waMessageId = await attempt(variant)
      workingPhone = variant
      lastError = null
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isRecipientNotAllowedError(message)) throw error
      lastError = error
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await updateContactPhone(contact.id, workingPhone)
  }

  const preview = args.caption?.trim() || `[${args.kind}]`
  await insertMessage({
    conversationId: args.conversationId,
    contentType: args.kind,
    contentText: args.caption ?? null,
    messageId: waMessageId,
  })
  await touchConversation(args.conversationId, preview)

  return { whatsapp_message_id: waMessageId }
}

export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const { contact, phoneNumberId, accessToken } = await resolveChannel(
    input.accountId,
    input.contactId,
  )

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const result = await sendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return result.messageId
    }

    const result = await sendInteractiveList({
      phoneNumberId,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return result.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      waMessageId = await attempt(variant)
      workingPhone = variant
      lastError = null
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isRecipientNotAllowedError(message)) throw error
      lastError = error
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await updateContactPhone(contact.id, workingPhone)
  }

  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  await insertMessage({
    conversationId: input.conversationId,
    contentType: 'interactive',
    contentText: input.bodyText,
    interactivePayload,
    messageId: waMessageId,
  })
  await touchConversation(input.conversationId, input.bodyText)

  return { whatsapp_message_id: waMessageId }
}
