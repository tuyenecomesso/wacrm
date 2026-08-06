import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils'
import { getPool } from '@/lib/pg'

const MAX_ROWS = 10_000
const DEFAULT_WINDOW_DAYS = 30

interface UsageRow {
  created_at: string
  mode: 'auto_reply' | 'draft'
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')
    const url = new URL(request.url)
    const rawDays = Number(url.searchParams.get('days'))
    const days =
      Number.isFinite(rawDays) && rawDays >= 1
        ? Math.min(90, Math.floor(rawDays))
        : DEFAULT_WINDOW_DAYS

    const since = daysAgoStart(days - 1)
    const { rows: all } = await getPool().query<UsageRow>(
      `SELECT created_at, mode, provider, model, prompt_tokens, completion_tokens, total_tokens
         FROM ai_usage_log
        WHERE account_id = $1
          AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [actor.accountId, since.toISOString(), MAX_ROWS + 1],
    )

    const truncated = all.length > MAX_ROWS
    const rows = truncated ? all.slice(0, MAX_ROWS) : all

    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0

    const byMode = {
      auto_reply: { calls: 0, tokens: 0 },
      draft: { calls: 0, tokens: 0 },
    }
    const modelMap = new Map<
      string,
      { model: string; provider: string; calls: number; tokens: number }
    >()
    const daily = new Map<string, { date: string; tokens: number; calls: number }>()

    for (const key of lastNDayKeys(days)) {
      daily.set(key, { date: key, tokens: 0, calls: 0 })
    }

    for (const row of rows) {
      promptTokens += row.prompt_tokens
      completionTokens += row.completion_tokens
      totalTokens += row.total_tokens
      byMode[row.mode].calls += 1
      byMode[row.mode].tokens += row.total_tokens

      const modelKey = `${row.provider}:${row.model}`
      const current =
        modelMap.get(modelKey) ??
        { model: row.model, provider: row.provider, calls: 0, tokens: 0 }
      current.calls += 1
      current.tokens += row.total_tokens
      modelMap.set(modelKey, current)

      const bucket = daily.get(localDayKey(row.created_at))
      if (bucket) {
        bucket.calls += 1
        bucket.tokens += row.total_tokens
      }
    }

    return NextResponse.json({
      window_days: days,
      truncated,
      totals: {
        calls: rows.length,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      by_mode: byMode,
      by_model: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
      daily: [...daily.values()],
    })
  } catch (error) {
    console.error('[ai/usage GET] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
