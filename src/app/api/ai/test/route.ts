import { NextResponse } from 'next/server'

import { AiError, type AiProvider } from '@/lib/ai/types'
import { validateAiCredentials } from '@/lib/ai/validate'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-test:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return NextResponse.json(
        { error: 'provider must be "openai" or "anthropic"' },
        { status: 400 },
      )
    }

    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 })
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKeyPlain = rawKey
    if (!apiKeyPlain) {
      const { rows } = await getPool().query<{ api_key: string | null }>(
        `SELECT api_key
           FROM ai_configs
          WHERE account_id = $1
          LIMIT 1`,
        [actor.accountId],
      )
      const existing = rows[0]
      if (!existing?.api_key) {
        return NextResponse.json({ error: 'Enter an API key to test.' }, { status: 400 })
      }
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return NextResponse.json(
          { error: 'Stored API key could not be decrypted; re-enter your key.' },
          { status: 400 },
        )
      }
    }

    try {
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
        handoffAgentId: null,
        embeddingsApiKey: null,
      })
    } catch (error) {
      if (error instanceof AiError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
      }
      console.error('[ai/test] validation error:', error)
      return NextResponse.json({ error: 'Could not validate the API key.' }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[ai/test] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
