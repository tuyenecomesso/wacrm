import { NextResponse } from 'next/server'

import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { generateReply } from '@/lib/ai/generate'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError } from '@/lib/ai/types'
import { logAiUsage } from '@/lib/ai/usage'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const userLimit = checkRateLimit(
      `ai-draft:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.aiDraft,
    )
    if (!userLimit.success) return rateLimitResponse(userLimit)

    const accountLimit = checkRateLimit(
      `ai-draft-acct:${actor.accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }

    const { rows: conversationRows } = await getPool().query<{ id: string }>(
      `SELECT id
         FROM conversations
        WHERE id = $1
          AND account_id = $2
        LIMIT 1`,
      [conversationId, actor.accountId],
    )
    if (conversationRows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const config = await loadAiConfig(getPool(), actor.accountId, {}).catch((error) => {
      console.error('[ai/draft] loadAiConfig error:', error)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in Settings -> AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const messages = await buildConversationContext(getPool(), conversationId)
    if (messages.length === 0) {
      return NextResponse.json({ error: 'No messages to draft from yet.', code: 'no_messages' }, { status: 400 })
    }

    const knowledge = await retrieveKnowledge(
      getPool(),
      actor.accountId,
      config,
      latestUserMessage(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
    })

    const { text, usage } = await generateReply({ config, systemPrompt, messages })
    void logAiUsage(getPool(), {
      accountId: actor.accountId,
      conversationId,
      mode: 'draft',
      provider: config.provider,
      model: config.model,
      usage,
    })

    return NextResponse.json({ draft: text })
  } catch (error) {
    if (error instanceof AiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('[ai/draft] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
