import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const deleteLocalMedia = vi.fn()

vi.mock('@/lib/pg', () => ({
  getPool: () => ({ query }),
}))

vi.mock('@/lib/storage/local', () => ({
  deleteLocalMedia: (path: string) => deleteLocalMedia(path),
}))

const { cleanupLocalMedia } = await import('./cleanup')

beforeEach(() => {
  query.mockReset()
  deleteLocalMedia.mockReset()
})

describe('cleanupLocalMedia', () => {
  it('deletes old chat media rows that are no longer referenced by messages', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ path: 'chat-media/acct-1/file.png', url: 'https://crm.test/api/whatsapp/media/chat-media/acct-1/file.png' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })

    const result = await cleanupLocalMedia({
      now: new Date('2026-08-05T00:00:00Z'),
      retentionDays: 30,
    })

    expect(deleteLocalMedia).toHaveBeenCalledWith('chat-media/acct-1/file.png')
    expect(query).toHaveBeenLastCalledWith('DELETE FROM chat_media WHERE path = $1', [
      'chat-media/acct-1/file.png',
    ])
    expect(result).toEqual({ scanned: 1, deleted: 1, missing: 0, kept: 0 })
  })

  it('keeps old chat media rows that are still referenced by messages', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ path: 'chat-media/acct-1/file.png', url: 'https://crm.test/api/whatsapp/media/chat-media/acct-1/file.png' }],
      })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] })

    const result = await cleanupLocalMedia({
      now: new Date('2026-08-05T00:00:00Z'),
      retentionDays: 30,
    })

    expect(deleteLocalMedia).not.toHaveBeenCalled()
    expect(result).toEqual({ scanned: 1, deleted: 0, missing: 0, kept: 1 })
  })

  it('treats already-missing files as deletable metadata cleanup', async () => {
    deleteLocalMedia.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    query
      .mockResolvedValueOnce({
        rows: [{ path: 'chat-media/acct-1/file.png', url: 'https://crm.test/api/whatsapp/media/chat-media/acct-1/file.png' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })

    const result = await cleanupLocalMedia({
      now: new Date('2026-08-05T00:00:00Z'),
      retentionDays: 30,
    })

    expect(result).toEqual({ scanned: 1, deleted: 1, missing: 1, kept: 0 })
  })
})
