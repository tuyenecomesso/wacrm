import { NextResponse } from 'next/server'

import { loadAiConfig } from '@/lib/ai/config'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { generateReply } from '@/lib/ai/generate'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MAX_TURNS = 20

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-playground:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.aiDraft,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (message: unknown): message is ChatMessage =>
          !!message &&
          typeof message === 'object' &&
          ((message as ChatMessage).role === 'user' ||
            (message as ChatMessage).role === 'assistant') &&
          typeof (message as ChatMessage).content === 'string' &&
          (message as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json({ error: 'Send a message to test the agent.' }, { status: 400 })
    }

    const config = await loadAiConfig(getPool(), actor.accountId, {
      requireActive: false,
    }).catch((error) => {
      console.error('[ai/playground] loadAiConfig error:', error)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const knowledge = await retrieveKnowledge(
      getPool(),
      actor.accountId,
      config,
      latestUserMessage(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff } = await generateReply({ config, systemPrompt, messages })
    return NextResponse.json({ reply: text, handoff })
  } catch (error) {
    if (error instanceof AiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    console.error('[ai/playground] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
