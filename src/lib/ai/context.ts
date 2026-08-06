import { aiContextMessageLimit } from './defaults'
import type { ChatMessage } from './types'

interface Queryable {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

export async function buildConversationContext(
  db: Queryable,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { rows: rawRows } = await db.query<DbMessage>(
    `SELECT sender_type, content_text
       FROM messages
      WHERE conversation_id = $1
        AND content_type = 'text'
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit],
  )

  return rawRows
    .reverse()
    .filter((message) => message.content_text && message.content_text.trim())
    .map((message) => ({
      role: message.sender_type === 'customer' ? 'user' : 'assistant',
      content: message.content_text!.trim(),
    }))
}
