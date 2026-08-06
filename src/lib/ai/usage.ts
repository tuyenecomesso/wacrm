import type { AiProvider, AiUsage } from './types'

interface Queryable {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

export interface LogAiUsageArgs {
  accountId: string
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  usage: AiUsage | null
}

export async function logAiUsage(
  db: Queryable,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    await db.query(
      `INSERT INTO ai_usage_log (
         account_id,
         conversation_id,
         mode,
         provider,
         model,
         prompt_tokens,
         completion_tokens,
         total_tokens
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.accountId,
        args.conversationId,
        args.mode,
        args.provider,
        args.model,
        args.usage.promptTokens,
        args.usage.completionTokens,
        args.usage.totalTokens,
      ],
    )
  } catch (error) {
    console.error('[ai usage] log insert threw:', error)
  }
}
