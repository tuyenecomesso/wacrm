import { describe, expect, it, vi } from 'vitest'
import { logAiUsage } from './usage'

function fakeDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const db = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ai_usage_log'),
      ['acct-1', 'conv-1', 'auto_reply', 'anthropic', 'claude-x', 30, 6, 36],
    )
  })

  it('is a no-op when the provider reported no usage', async () => {
    const db = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('never throws when the insert errors', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('boom')) }
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})
