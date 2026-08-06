import { NextResponse } from 'next/server'

import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { rows } = await getPool().query<{
      id: string
      title: string
      updated_at: string
    }>(
      `SELECT id, title, updated_at
         FROM ai_knowledge_documents
        WHERE account_id = $1
        ORDER BY updated_at DESC`,
      [actor.accountId],
    )
    return NextResponse.json({ documents: rows })
  } catch (error) {
    console.error('[ai/knowledge GET] error:', error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-kb:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json({ error: 'title and content are required' }, { status: 400 })
    }

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO ai_knowledge_documents (account_id, created_by, title, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        actor.accountId,
        actor.authType === 'api_key' ? actor.createdBy : null,
        title,
        content,
      ],
    )

    const doc = rows[0]
    if (!doc) {
      return NextResponse.json({ error: 'Failed to save document' }, { status: 500 })
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(getPool(), actor.accountId)
    try {
      await ingestDocument(getPool(), actor.accountId, { embeddingsApiKey }, doc.id, content)
    } catch (error) {
      const message = error instanceof AiError ? error.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', error)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only; your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }

    return NextResponse.json({ success: true, id: doc.id })
  } catch (error) {
    console.error('[ai/knowledge POST] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
