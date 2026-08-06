import { NextResponse } from 'next/server'

import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const actor = await requireApiActor(_request, 'admin')
    const { id } = await params
    const { rows } = await getPool().query<{
      id: string
      title: string
      content: string
      updated_at: string
    }>(
      `SELECT id, title, content, updated_at
         FROM ai_knowledge_documents
        WHERE account_id = $1
          AND id = $2
        LIMIT 1`,
      [actor.accountId, id],
    )
    const doc = rows[0]
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(doc)
  } catch (error) {
    console.error('[ai/knowledge/[id] GET] error:', error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-kb:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })
    }

    const sets: string[] = []
    const values: unknown[] = [actor.accountId, id]
    if (title !== undefined) {
      sets.push(`title = $${values.length + 1}`)
      values.push(title)
    }
    if (content !== undefined) {
      sets.push(`content = $${values.length + 1}`)
      values.push(content)
    }

    const { rows } = await getPool().query<{ id: string }>(
      `UPDATE ai_knowledge_documents
          SET ${sets.join(', ')}
        WHERE account_id = $1
          AND id = $2
      RETURNING id`,
      values,
    )

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(getPool(), actor.accountId)
      try {
        await ingestDocument(getPool(), actor.accountId, { embeddingsApiKey }, id, content)
      } catch (error) {
        const message = error instanceof AiError ? error.message : 'indexing failed'
        console.error('[ai/knowledge/[id] PATCH] ingest error:', error)
        return NextResponse.json(
          {
            success: true,
            warning: `Updated, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
          },
          { status: 200 },
        )
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Updated with keyword search only; your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[ai/knowledge/[id] PATCH] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const { id } = await params
    await getPool().query(
      `DELETE FROM ai_knowledge_documents
        WHERE account_id = $1
          AND id = $2`,
      [actor.accountId, id],
    )
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[ai/knowledge/[id] DELETE] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
