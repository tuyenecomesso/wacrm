import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import type { AiConfig } from './types'

interface MatchRow {
  id: string
  content: string
}

interface Queryable {
  query<T>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>
}

export async function ingestDocument(
  db: Queryable,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  await db.query('DELETE FROM ai_knowledge_chunks WHERE document_id = $1', [documentId])

  if (chunks.length === 0) return

  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (error) {
      embedError = error
    }
  }

  const values = chunks.map((chunk, index) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: index,
    content: chunk,
    embedding: embeddings ? toVectorLiteral(embeddings[index]) : null,
  }))

  const placeholders = values
    .map(
      (_, index) =>
        `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`,
    )
    .join(', ')

  await db.query(
    `INSERT INTO ai_knowledge_chunks (
       document_id,
       account_id,
       chunk_index,
       content,
       embedding
     ) VALUES ${placeholders}`,
    values.flatMap((value) => [
      value.document_id,
      value.account_id,
      value.chunk_index,
      value.content,
      value.embedding,
    ]),
  )

  if (embedError) throw embedError
}

export async function retrieveKnowledge(
  db: Queryable,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  try {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ai_knowledge_chunks
        WHERE account_id = $1`,
      [accountId],
    )
    if (!rows[0] || Number(rows[0].count) === 0) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>()

  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const { rows } = await db.query<MatchRow>(
          'SELECT id, content FROM match_ai_knowledge_semantic($1, $2, $3)',
          [accountId, toVectorLiteral(queryEmbedding), k],
        )
        for (const row of rows) picked.set(row.id, row.content)
      }
    } catch (error) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', error)
    }
  }

  if (picked.size < k) {
    try {
      const { rows } = await db.query<MatchRow>(
        'SELECT id, content FROM match_ai_knowledge_fts($1, $2, $3)',
        [accountId, query, k],
      )
      for (const row of rows) {
        if (picked.size >= k) break
        if (!picked.has(row.id)) picked.set(row.id, row.content)
      }
    } catch (error) {
      console.error('[ai knowledge] lexical retrieval failed:', error)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
