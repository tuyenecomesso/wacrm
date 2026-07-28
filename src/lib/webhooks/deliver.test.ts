import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plain-secret'),
}))

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (url: string) => url.startsWith('https://public')),
}))

function makeResult(data: unknown) {
  return Promise.resolve({ data, error: null })
}

describe('dispatchWebhookEvent', () => {
  it('delivers to bypass_ssrf endpoints without SSRF check', async () => {
    const endpoints = [{ id: 'ep-1', url: 'http://internal:8001/webhook', secret: 'enc', bypass_ssrf: true }]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              contains: vi.fn(() => makeResult(endpoints)),
            })),
          })),
        })),
      })),
      rpc: vi.fn(() => Promise.resolve({ error: null })),
    }

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: new Headers(),
    })) as any

    const { dispatchWebhookEvent } = await import('./deliver')
    await dispatchWebhookEvent(db as any, 'acct-1', 'message.received' as any, { text: 'hello' })

    expect(global.fetch).toHaveBeenCalledWith(
      'http://internal:8001/webhook',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('skips delivery when SSRF guard blocks non-bypass endpoint', async () => {
    const endpoints = [{ id: 'ep-2', url: 'http://internal:8001/webhook', secret: 'enc', bypass_ssrf: false }]
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              contains: vi.fn(() => makeResult(endpoints)),
            })),
          })),
        })),
      })),
      rpc: vi.fn(() => Promise.resolve({ error: null })),
    }

    global.fetch = vi.fn() as any

    const { dispatchWebhookEvent } = await import('./deliver')
    await dispatchWebhookEvent(db as any, 'acct-1', 'message.received' as any, { text: 'hello' })

    expect(global.fetch).not.toHaveBeenCalled()
    expect(db.rpc).toHaveBeenCalled()
  })

  it('returns early when no endpoints match', async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              contains: vi.fn(() => makeResult([])),
            })),
          })),
        })),
      })),
      rpc: vi.fn(() => Promise.resolve({ error: null })),
    }

    global.fetch = vi.fn() as any

    const { dispatchWebhookEvent } = await import('./deliver')
    await dispatchWebhookEvent(db as any, 'acct-1', 'message.received' as any, { text: 'hello' })

    expect(global.fetch).not.toHaveBeenCalled()
  })
})
