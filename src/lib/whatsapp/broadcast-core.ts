// ============================================================
// Public-API broadcast core on direct Postgres.
// ============================================================

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { getPool } from '@/lib/pg';

export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  to: string;
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

export async function createBroadcast(
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  const pool = getPool();

  const { rows: configRows } = await pool.query<{
    phone_number_id: string | null;
    access_token: string | null;
  }>(
    `SELECT phone_number_id, access_token
     FROM whatsapp_config
     WHERE account_id = $1
     LIMIT 1`,
    [accountId]
  );

  const config = configRows[0];
  if (!config?.phone_number_id || !config.access_token) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const accessToken = decrypt(config.access_token);

  const { rows: templateRows } = await pool.query<Record<string, unknown>>(
    `SELECT *
     FROM message_templates
     WHERE account_id = $1
       AND name = $2
       AND language = $3
     LIMIT 1`,
    [accountId, templateName, templateLanguage]
  );

  const rawTemplateRow = templateRows[0] ?? null;
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null;

  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;

  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  const { rows: broadcastRows } = await pool.query<{ id: string }>(
    `INSERT INTO broadcasts
      (account_id, user_id, name, template_name, template_language, status, total_recipients)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      accountId,
      auditUserId,
      name || `API broadcast (${templateName})`,
      templateName,
      templateLanguage,
      'sending',
      deduped.length,
    ]
  );
  const broadcast = broadcastRows[0];
  if (!broadcast) {
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const recipientValues: unknown[] = [];
  const valueSql: string[] = [];
  for (const recipient of deduped) {
    recipientValues.push(broadcast.id, recipient.contactId, 'pending');
    const offset = recipientValues.length - 2;
    valueSql.push(`($${offset}, $${offset + 1}, $${offset + 2})`);
  }

  const { rows: recipientRows } = await pool.query<{
    id: string;
    contact_id: string;
  }>(
    `INSERT INTO broadcast_recipients (broadcast_id, contact_id, status)
     VALUES ${valueSql.join(', ')}
     RETURNING id, contact_id`,
    recipientValues
  );

  if (recipientRows.length === 0) {
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = recipientRows.map((row) => {
    const recipient = byContact.get(row.contact_id)!;
    return {
      recipientRowId: row.id,
      phone: recipient.phone,
      params: recipient.params,
    };
  });

  return {
    broadcastId: broadcast.id,
    templateName,
    templateLanguage,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

export async function deliverBroadcast(plan: BroadcastPlan): Promise<void> {
  const pool = getPool();
  let sentCount = 0;

  for (const recipient of plan.planned) {
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      sentCount++;
      await pool.query(
        `UPDATE broadcast_recipients
         SET status = 'sent',
             sent_at = $2,
             whatsapp_message_id = $3,
             error_message = NULL
         WHERE id = $1`,
        [recipient.recipientRowId, new Date().toISOString(), sentMessageId]
      );
    } else {
      await pool.query(
        `UPDATE broadcast_recipients
         SET status = 'failed',
             error_message = $2
         WHERE id = $1`,
        [recipient.recipientRowId, lastError || 'Unknown error']
      );
    }
  }

  await pool.query(
    `UPDATE broadcasts
     SET status = $2,
         updated_at = $3
     WHERE id = $1`,
    [plan.broadcastId, sentCount > 0 ? 'sent' : 'failed', new Date().toISOString()]
  );
}
