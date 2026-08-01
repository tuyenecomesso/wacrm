import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plain-secret'),
}))

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (url: string) => url.startsWith('https://public')),
}))

vi.mock('@/lib/webhooks/pg-repo', () => ({
  listActiveEndpointsForEvent: vi.fn(),
  markWebhookEndpointDelivered: vi.fn(async () => {}),
  recordWebhookEndpointFailure: vi.fn(async () => {}),
}))

import { listActiveEndpointsForEvent, recordWebhookEndpointFailure } from '@/lib/webhooks/pg-repo'
import type { WebhookEvent } from '@/lib/webhooks/events'

const mockedList = vi.mocked(listActiveEndpointsForEvent)
const mockedRecord = vi.mocked(recordWebhookEndpointFailure)

function okResponse(): Response {
  return new Response(JSON.stringify({}), { status: 200 })
}

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    mockedList.mockReset()
    mockedRecord.mockReset()
  })

  it('delivers to bypass_ssrf endpoints without SSRF check', async () => {
    mockedList.mockResolvedValue([
      { id: 'ep-1', url: 'http://internal:8001/webhook', secret: 'enc', bypass_ssrf: true },
    ])

    const fetchSpy = vi.fn(async () => okResponse())
    globalThis.fetch = fetchSpy

    const { dispatchWebhookEvent } = await import('./deliver')
    await dispatchWebhookEvent('acct-1', 'message.received' as WebhookEvent, { text: 'hello' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://internal:8001/webhook',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('skips delivery when SSRF guard blocks non-bypass endpoint', async () => {
    mockedList.mockResolvedValue([
      { id: 'ep-2', url: 'http://internal:8001/webhook', secret: 'enc', bypass_ssrf: false },
    ])

    globalThis.fetch = vi.fn()

    const { dispatchWebhookEvent } = await import('./deliver')
    await dispatchWebhookEvent('acct-1', 'message.received' as WebhookEvent, { text: 'hello' })

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockedRecord).toHaveBeenCalled()
  })

  it('returns early when no endpoints match', async () => {
    mockedList.mockResolvedValue([])

    globalThis.fetch = vi.fn()

    const { dispatchWebhookEvent } = await import('./deliver')
    await dispatchWebhookEvent('acct-1', 'message.received' as WebhookEvent, { text: 'hello' })

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
