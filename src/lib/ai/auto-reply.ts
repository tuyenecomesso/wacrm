import { buildSystemPrompt } from './defaults'
import { generateReply } from './generate'
import { buildHandoffSummary } from './handoff'
import { retrieveKnowledge } from './knowledge'
import { latestUserMessage } from './query'
import { logAiUsage } from './usage'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { engineSendText } from '@/lib/flows/meta-send'
import { getPool } from '@/lib/pg'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}

export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = getPool()
    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    const { rows: autoResponders } = await db.query<{ id: string }>(
      `SELECT id
         FROM automations
        WHERE account_id = $1
          AND is_active = true
          AND trigger_type = ANY($2::text[])
        LIMIT 1`,
      [accountId, ['new_message_received', 'keyword_match']],
    )
    if (autoResponders.length > 0) return

    const { rows: convRows } = await db.query<{
      assigned_agent_id: string | null
      ai_autoreply_disabled: boolean
      ai_reply_count: number
    }>(
      `SELECT assigned_agent_id, ai_autoreply_disabled, ai_reply_count
         FROM conversations
        WHERE id = $1
        LIMIT 1`,
      [conversationId],
    )
    const conv = convRows[0]
    if (!conv) return
    if (conv.assigned_agent_id) return
    if (conv.ai_autoreply_disabled) return
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit; skipping this inbound.`,
      )
      return
    }

    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })

      if (config.handoffAgentId && !conv.assigned_agent_id) {
        await db.query(
          `UPDATE conversations
              SET ai_autoreply_disabled = true,
                  ai_handoff_summary = $2,
                  assigned_agent_id = $3
            WHERE id = $1`,
          [conversationId, summary, config.handoffAgentId],
        )
      } else {
        await db.query(
          `UPDATE conversations
              SET ai_autoreply_disabled = true,
                  ai_handoff_summary = $2
            WHERE id = $1`,
          [conversationId, summary],
        )
      }
      return
    }

    const { rows: claimedRows } = await db.query<{ claim_ai_reply_slot: boolean }>(
      'SELECT claim_ai_reply_slot($1, $2) AS claim_ai_reply_slot',
      [conversationId, config.autoReplyMaxPerConversation],
    )
    if (claimedRows[0]?.claim_ai_reply_slot !== true) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (error) {
    console.error('[ai auto-reply] dispatch failed:', error)
  }
}
