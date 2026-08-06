import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { getPool } from '@/lib/pg'
import { getConfigByAccount } from '@/lib/whatsapp/pg-config'

interface SendTextArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

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
  templateName?: string | null
  messageId: string
}): Promise<void> {
  await getPool().query(
    `INSERT INTO messages (
       conversation_id,
       sender_type,
       content_type,
       content_text,
       template_name,
       message_id,
       status
     ) VALUES ($1, 'bot', $2, $3, $4, $5, 'sent')`,
    [
      params.conversationId,
      params.contentType,
      params.contentText,
      params.templateName ?? null,
      params.messageId,
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
  args: SendTextArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const { contact, phoneNumberId, accessToken } = await resolveChannel(
    input.accountId,
    input.contactId,
  )

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return result.messageId
    }

    const result = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      text: input.text,
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

  const contentType = input.kind === 'template' ? 'template' : 'text'
  const contentText = input.kind === 'text' ? input.text : null
  const templateName = input.kind === 'template' ? input.templateName : null

  await insertMessage({
    conversationId: input.conversationId,
    contentType,
    contentText,
    templateName,
    messageId: waMessageId,
  })
  await touchConversation(
    input.conversationId,
    input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
  )

  return { whatsapp_message_id: waMessageId }
}
