// ============================================================
// Outbound message send on direct Postgres.
// ============================================================

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { getPool } from '@/lib/pg';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  templateMessageParams?: unknown;
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  messageId: string;
  whatsappMessageId: string;
}

export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError('bad_request', 'conversation_id is required', 400);
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const pool = getPool();
  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  const { rows: conversationRows } = await pool.query<{
    id: string;
    contact_id: string;
    phone: string | null;
    contact_name: string | null;
  }>(
    `SELECT conv.id, conv.contact_id, c.phone, c.name AS contact_name
     FROM conversations conv
     LEFT JOIN contacts c ON c.id = conv.contact_id
     WHERE conv.id = $1
       AND conv.account_id = $2
     LIMIT 1`,
    [conversationId, accountId]
  );

  const conversation = conversationRows[0];
  if (!conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }
  if (!conversation.phone) {
    throw new SendMessageError('bad_request', 'Contact phone number not found', 400);
  }

  const sanitizedPhone = sanitizePhoneForMeta(conversation.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError('bad_request', 'Invalid phone number format', 400);
  }

  const { rows: configRows } = await pool.query<{
    id: string;
    phone_number_id: string | null;
    access_token: string | null;
  }>(
    `SELECT id, phone_number_id, access_token
     FROM whatsapp_config
     WHERE account_id = $1
     LIMIT 1`,
    [accountId]
  );

  const config = configRows[0];
  if (!config?.phone_number_id || !config.access_token) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const accessToken = decrypt(config.access_token);

  if (isLegacyFormat(config.access_token)) {
    void pool.query(
      `UPDATE whatsapp_config
       SET access_token = $2
       WHERE id = $1`,
      [config.id, encrypt(accessToken)]
    ).catch((error: unknown) => {
      console.warn(
        '[send-message] access_token GCM upgrade failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { rows: parentRows } = await pool.query<{
      message_id: string | null;
    }>(
      `SELECT message_id
       FROM messages
       WHERE id = $1
         AND conversation_id = $2
       LIMIT 1`,
      [replyToMessageId, conversationId]
    );
    const parent = parentRows[0];
    if (!parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (parent.message_id) contextMessageId = parent.message_id;
  }

  let templateRow: MessageTemplate | null = null;
  if (messageType === 'template' && templateName) {
    const { rows: templateRows } = await pool.query<Record<string, unknown>>(
      `SELECT *
       FROM message_templates
       WHERE account_id = $1
         AND name = $2
         AND language = $3
       LIMIT 1`,
      [accountId, templateName, templateLanguage || 'en_US']
    );
    const data = templateRows[0] ?? null;
    if (data && !isMessageTemplate(data)) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = (data as MessageTemplate | null) ?? null;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id!,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: templateLanguage || 'en_US',
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id!,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id!,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id!,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id!,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants = phoneVariants(sanitizedPhone);
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (workingPhone !== sanitizedPhone) {
    await pool.query(
      `UPDATE contacts
       SET phone = $2
       WHERE id = $1`,
      [conversation.contact_id, workingPhone]
    );
  }

  const interactiveBody =
    messageType === 'interactive' ? interactivePayload!.body : null;

  const { rows: messageRows } = await pool.query<{ id: string }>(
    `INSERT INTO messages
      (conversation_id, sender_type, content_type, content_text, media_url,
       template_name, interactive_payload, message_id, status, reply_to_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     RETURNING id`,
    [
      conversationId,
      'agent',
      messageType,
      interactiveBody ?? contentText ?? null,
      mediaUrl || null,
      templateName || null,
      messageType === 'interactive' ? JSON.stringify(interactivePayload) : null,
      waMessageId,
      'sent',
      replyToMessageId || null,
    ]
  );

  const messageRecord = messageRows[0];
  if (!messageRecord) {
    throw new SendMessageError(
      'db_error',
      'Message sent to Meta but failed to save to DB',
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : contentText || `[${messageType}]`;

  await pool.query(
    `UPDATE conversations
     SET last_message_text = $2,
         last_message_at = $3,
         updated_at = $4
     WHERE id = $1`,
    [conversationId, lastMessageText, new Date().toISOString(), new Date().toISOString()]
  );

  try {
    await pool.query(
      `UPDATE flow_runs
       SET status = 'paused_by_agent',
           ended_at = $3,
           end_reason = 'agent_replied'
       WHERE account_id = $1
         AND contact_id = $2
         AND status = 'active'`,
      [accountId, conversation.contact_id, new Date().toISOString()]
    );
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
