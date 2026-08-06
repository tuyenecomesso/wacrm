// ============================================================
// Resolve (or create) the conversation for a phone number using pg.
// ============================================================

import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { getPool } from '@/lib/pg';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  contactCreated: boolean;
}

export async function resolveConversationByPhone(
  accountId: string,
  phone: string,
  name?: string | null
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const pool = getPool();

  const { rows: configRows } = await pool.query<{ id: string }>(
    `SELECT id
     FROM whatsapp_config
     WHERE account_id = $1
     LIMIT 1`,
    [accountId]
  );
  if (!configRows[0]) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  let contactId: string;
  let contactCreated = false;

  const { rows: existingContactRows } = await pool.query<{
    id: string;
    phone: string;
    name: string | null;
  }>(
    `SELECT id, phone, name
     FROM contacts
     WHERE account_id = $1
       AND phone_normalized = regexp_replace($2, '\D', '', 'g')
     LIMIT 1`,
    [accountId, sanitized]
  );

  const existing = existingContactRows[0];
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await pool.query(
        `UPDATE contacts
         SET name = $2, updated_at = $3
         WHERE id = $1`,
        [existing.id, name, new Date().toISOString()]
      );
    }
  } else {
    try {
      const { rows: createdRows } = await pool.query<{ id: string }>(
        `INSERT INTO contacts (account_id, user_id, phone, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [accountId, ownerUserId, sanitized, name || sanitized]
      );
      contactId = createdRows[0].id;
      contactCreated = true;
    } catch (createErr) {
      if ((createErr as { code?: string }).code === '23505') {
        const { rows: racedRows } = await pool.query<{ id: string }>(
          `SELECT id
           FROM contacts
           WHERE account_id = $1
             AND phone_normalized = regexp_replace($2, '\D', '', 'g')
           LIMIT 1`,
          [accountId, sanitized]
        );
        if (!racedRows[0]) {
          throw new SendMessageError('db_error', 'Failed to create contact', 500);
        }
        contactId = racedRows[0].id;
      } else {
        console.error('[resolve-conversation] contact create error:', createErr);
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    }
  }

  const { rows: convRows } = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversations
     WHERE account_id = $1
       AND contact_id = $2
     LIMIT 1`,
    [accountId, contactId]
  );
  if (convRows[0]?.id) {
    return { conversationId: convRows[0].id, contactId, contactCreated };
  }

  const { rows: newConvRows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (account_id, user_id, contact_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [accountId, ownerUserId, contactId]
  );

  if (!newConvRows[0]) {
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return {
    conversationId: newConvRows[0].id,
    contactId,
    contactCreated,
  };
}
