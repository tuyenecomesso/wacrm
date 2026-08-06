import { getPool } from '@/lib/pg'
import { deleteLocalMedia } from '@/lib/storage/local'

const DEFAULT_RETENTION_DAYS = 30

export interface CleanupLocalMediaOptions {
  retentionDays?: number
  now?: Date
  batchSize?: number
}

export interface CleanupLocalMediaResult {
  scanned: number
  deleted: number
  missing: number
  kept: number
}

type ChatMediaRow = {
  path: string
  url: string
}

export async function cleanupLocalMedia(
  options: CleanupLocalMediaOptions = {},
): Promise<CleanupLocalMediaResult> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS
  const batchSize = options.batchSize ?? 200
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const pool = getPool()

  const { rows } = await pool.query<ChatMediaRow>(
    `SELECT path, url
       FROM chat_media
      WHERE created_at < $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [cutoff.toISOString(), batchSize],
  )

  let deleted = 0
  let missing = 0
  let kept = 0

  for (const row of rows) {
    const { rows: refs } = await pool.query<{ exists: number }>(
      `SELECT 1 AS exists
         FROM messages
        WHERE media_url = $1
        LIMIT 1`,
      [row.url],
    )

    if (refs.length > 0) {
      kept += 1
      continue
    }

    try {
      await deleteLocalMedia(row.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      missing += 1
    }

    await pool.query(`DELETE FROM chat_media WHERE path = $1`, [row.path])
    deleted += 1
  }

  return {
    scanned: rows.length,
    deleted,
    missing,
    kept,
  }
}
