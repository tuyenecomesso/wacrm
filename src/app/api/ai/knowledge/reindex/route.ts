import { NextResponse } from 'next/server'

import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const limit = checkRateLimit(
      `ai-kb-reindex:${actor.authType === 'api_key' ? actor.createdBy ?? actor.keyId : actor.endpointId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { rows: docs } = await getPool().query<{ id: string; content: string }>(
      `SELECT id, content
         FROM ai_knowledge_documents
        WHERE account_id = $1`,
      [actor.accountId],
    )

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(getPool(), actor.accountId)
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings -> AI Assistant). Nothing was reindexed.',
        },
        { status: 200 },
      )
    }

    let reindexed = 0
    for (const doc of docs) {
      try {
        await ingestDocument(getPool(), actor.accountId, { embeddingsApiKey }, doc.id, doc.content)
        reindexed += 1
      } catch (error) {
        const message = error instanceof AiError ? error.message : String(error)
        console.error(`[ai/knowledge/reindex] doc ${doc.id} failed:`, message)
        return NextResponse.json(
          {
            success: false,
            reindexed,
            total: docs.length,
            error: `Reindexed ${reindexed}, then hit an error: ${message}`,
          },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ success: true, reindexed })
  } catch (error) {
    console.error('[ai/knowledge/reindex] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
