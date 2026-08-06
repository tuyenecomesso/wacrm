import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig } from './types'

interface AiConfigRow {
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

interface Queryable {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

export async function loadAiConfig(
  db: Queryable,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { rows } = await db.query<AiConfigRow>(
    `SELECT ${CONFIG_COLUMNS}
       FROM ai_configs
      WHERE account_id = $1
      LIMIT 1`,
    [accountId],
  )

  const row = rows[0]
  if (!row) return null
  if (requireActive && !row.is_active) return null
  if (!row.api_key) return null

  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

export async function loadEmbeddingsKey(
  db: Queryable,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { rows } = await db.query<{ embeddings_api_key: string | null }>(
    `SELECT embeddings_api_key
       FROM ai_configs
      WHERE account_id = $1
      LIMIT 1`,
    [accountId],
  )

  const row = rows[0]
  if (!row?.embeddings_api_key) return { key: null, corrupt: false }

  try {
    return { key: decrypt(row.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted.`,
    )
    return { key: null, corrupt: true }
  }
}
