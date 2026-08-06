import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { rows } = await getPool().query<{
      provider: AiProvider
      model: string
      system_prompt: string | null
      is_active: boolean
      auto_reply_enabled: boolean
      auto_reply_max_per_conversation: number
      handoff_agent_id: string | null
      api_key: string | null
      embeddings_api_key: string | null
    }>(
      `SELECT provider, model, system_prompt, is_active, auto_reply_enabled,
              auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key
         FROM ai_configs
        WHERE account_id = $1
        LIMIT 1`,
      [actor.accountId],
    )

    const data = rows[0]
    if (!data) return NextResponse.json({ configured: false })

    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      ...safe,
    })
  } catch (error) {
    console.error('[ai/config GET] error:', error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-config:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return bad('provider must be "openai" or "anthropic"')
    }

    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { rows } = await getPool().query<{ user_id: string }>(
        `SELECT user_id
           FROM profiles
          WHERE account_id = $1
            AND user_id = $2
          LIMIT 1`,
        [actor.accountId, rawHandoff],
      )
      if (rows.length === 0) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string' ? body.embeddings_api_key.trim() : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    const { rows: existingRows } = await getPool().query<{
      id: string
      provider: AiProvider
      model: string
      api_key: string | null
    }>(
      `SELECT id, provider, model, api_key
         FROM ai_configs
        WHERE account_id = $1
        LIMIT 1`,
      [actor.accountId],
    )
    const existing = existingRows[0]

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted; re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        })
      } catch (error) {
        if (error instanceof AiError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
        }
        console.error('[ai/config POST] validation error:', error)
        return bad('Could not validate the API key with the provider.')
      }
    }

    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (error) {
        if (error instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${error.message}`, code: error.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', error)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null

    if (existing) {
      const sets = [
        'provider = $2',
        'model = $3',
        'system_prompt = $4',
        'is_active = $5',
        'auto_reply_enabled = $6',
        'auto_reply_max_per_conversation = $7',
      ]
      const params: unknown[] = [
        actor.accountId,
        provider,
        model,
        systemPrompt,
        isActive,
        autoReplyEnabled,
        maxPer,
      ]

      if (handoffProvided) {
        sets.push(`handoff_agent_id = $${params.length + 1}`)
        params.push(handoffAgentId)
      }
      if (encryptedKey) {
        sets.push(`api_key = $${params.length + 1}`)
        params.push(encryptedKey)
      }
      if (rawEmbeddingsKey) {
        sets.push(`embeddings_api_key = $${params.length + 1}`)
        params.push(encrypt(rawEmbeddingsKey))
      } else if (clearEmbeddingsKey) {
        sets.push(`embeddings_api_key = $${params.length + 1}`)
        params.push(null)
      }

      await getPool().query(
        `UPDATE ai_configs
            SET ${sets.join(', ')}
          WHERE account_id = $1`,
        params,
      )
    } else {
      await getPool().query(
        `INSERT INTO ai_configs (
           account_id,
           created_by,
           provider,
           model,
           api_key,
           system_prompt,
           is_active,
           auto_reply_enabled,
           auto_reply_max_per_conversation,
           handoff_agent_id,
           embeddings_api_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          actor.accountId,
          actor.authType === 'api_key' ? actor.createdBy : null,
          provider,
          model,
          encrypt(apiKeyPlain),
          systemPrompt,
          isActive,
          autoReplyEnabled,
          maxPer,
          handoffProvided ? handoffAgentId : null,
          rawEmbeddingsKey ? encrypt(rawEmbeddingsKey) : null,
        ],
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[ai/config POST] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    await getPool().query('DELETE FROM ai_configs WHERE account_id = $1', [actor.accountId])
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[ai/config DELETE] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
