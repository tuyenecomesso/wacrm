// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
// ============================================================

import type { Conversation, Message } from '@/types';
import type { Cursor } from '@/lib/api/v1/pagination';
import { getPool } from '@/lib/pg';

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

/**
 * Project a normalized `Conversation` (from `normalizeConversation`,
 * which has already flattened `contact.tags`) into the public shape.
 */
export function serializeConversation(conv: Conversation): ApiConversation {
  const c = conv.contact;
  return {
    id: conv.id,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
}

/** Project a `messages` row into the public shape. */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}

interface ConversationRow {
  id: string;
  user_id: string;
  contact_id: string;
  status: 'open' | 'pending' | 'closed';
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

function conversationSelectSql(): string {
  return `
    SELECT
      conv.id,
      conv.user_id,
      conv.contact_id,
      conv.status,
      conv.assigned_agent_id,
      conv.last_message_text,
      conv.last_message_at,
      conv.unread_count,
      conv.created_at,
      conv.updated_at,
      CASE
        WHEN c.id IS NULL THEN NULL
        ELSE jsonb_build_object(
          'id', c.id,
          'phone', c.phone,
          'name', c.name,
          'email', c.email,
          'company', c.company,
          'tags', COALESCE((
            SELECT json_agg(
              DISTINCT jsonb_build_object(
                'id', t.id,
                'name', t.name,
                'color', t.color
              )
            )
            FROM contact_tags ct
            JOIN tags t ON t.id = ct.tag_id
            WHERE ct.contact_id = c.id
          ), '[]'::json)
        )
      END AS contact
    FROM conversations conv
    LEFT JOIN contacts c ON c.id = conv.contact_id
  `;
}

export async function listConversations(params: {
  accountId: string;
  limit: number;
  cursor: Cursor | null;
  status: string | null;
  contactId: string | null;
}): Promise<Conversation[]> {
  const values: unknown[] = [params.accountId];
  const where = ['conv.account_id = $1'];

  if (params.status) {
    values.push(params.status);
    where.push(`conv.status = $${values.length}`);
  }

  if (params.contactId) {
    values.push(params.contactId);
    where.push(`conv.contact_id = $${values.length}`);
  }

  if (params.cursor) {
    values.push(params.cursor.createdAt, params.cursor.id);
    const tsIdx = values.length - 1;
    const idIdx = values.length;
    where.push(`(
      conv.created_at < $${tsIdx}
      OR (conv.created_at = $${tsIdx} AND conv.id < $${idIdx})
    )`);
  }

  values.push(params.limit + 1);

  const { rows } = await getPool().query<ConversationRow>(
    `${conversationSelectSql()}
     WHERE ${where.join(' AND ')}
     ORDER BY conv.created_at DESC, conv.id DESC
     LIMIT $${values.length}`,
    values
  );

  return rows as unknown as Conversation[];
}

export async function getConversationById(
  accountId: string,
  id: string
): Promise<Conversation | null> {
  const { rows } = await getPool().query<ConversationRow>(
    `${conversationSelectSql()}
     WHERE conv.account_id = $1
       AND conv.id = $2
     LIMIT 1`,
    [accountId, id]
  );
  return (rows[0] as unknown as Conversation) ?? null;
}

export async function listConversationMessages(params: {
  accountId: string;
  conversationId: string;
  limit: number;
  cursor: Cursor | null;
}): Promise<Message[] | null> {
  const { rows: convRows } = await getPool().query<{ id: string }>(
    `SELECT id
     FROM conversations
     WHERE account_id = $1
       AND id = $2
     LIMIT 1`,
    [params.accountId, params.conversationId]
  );

  if (!convRows[0]) return null;

  const values: unknown[] = [params.conversationId];
  const where = ['conversation_id = $1'];

  if (params.cursor) {
    values.push(params.cursor.createdAt, params.cursor.id);
    const tsIdx = values.length - 1;
    const idIdx = values.length;
    where.push(`(
      created_at < $${tsIdx}
      OR (created_at = $${tsIdx} AND id < $${idIdx})
    )`);
  }

  values.push(params.limit + 1);

  const { rows } = await getPool().query<Message>(
    `SELECT *
     FROM messages
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values
  );

  return rows;
}
