import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn(() => 'encrypted-secret'),
  decrypt: vi.fn(() => 'existing-whsec'),
}))

vi.mock('@/lib/webhooks/pg-repo', () => ({
  insertWebhookEndpoint: vi.fn(),
  deleteWebhookEndpointByAccountAndName: vi.fn(),
  getWebhookEndpointByAccountAndName: vi.fn(),
  updateWebhookEndpoint: vi.fn(),
}))

import {
  insertWebhookEndpoint,
  deleteWebhookEndpointByAccountAndName,
  getWebhookEndpointByAccountAndName,
  updateWebhookEndpoint,
} from '@/lib/webhooks/pg-repo'

const mockedInsert = vi.mocked(insertWebhookEndpoint)
const mockedDelete = vi.mocked(deleteWebhookEndpointByAccountAndName)
const mockedGetByName = vi.mocked(getWebhookEndpointByAccountAndName)
const mockedUpdate = vi.mocked(updateWebhookEndpoint)

const ENV_BACKUP = { ...process.env }

afterEach(() => {
  process.env = { ...ENV_BACKUP }
})

beforeEach(() => {
  mockedInsert.mockReset()
  mockedDelete.mockReset()
  mockedGetByName.mockReset()
  mockedUpdate.mockReset()
})

function endpointRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'new-id',
    account_id: '00000000-0000-0000-0000-000000000001',
    created_by: null,
    name: 'test-hub',
    url: 'http://bh:8001/webhook/whatsapp/wacrm',
    secret: 'encrypted-secret',
    events: ['message.received'],
    is_active: true,
    bypass_ssrf: true,
    last_delivery_at: null,
    failure_count: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('GET /api/integrations', () => {
  it('returns 200 with valid secret', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    const { GET } = await import('./route')

    const req = new Request('http://localhost/api/integrations', {
      headers: { 'x-internal-secret': 'my-secret' },
    })
    const resp = await GET(req)
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.ok).toBe(true)
  })

  it('returns 401 without valid secret', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    const { GET } = await import('./route')

    const req = new Request('http://localhost/api/integrations')
    const resp = await GET(req)
    expect(resp.status).toBe(401)
  })
})

describe('POST /api/integrations', () => {
  it('creates integration with valid body', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    mockedGetByName.mockResolvedValue(null as never)
    mockedInsert.mockResolvedValue(endpointRow() as never)
    const { POST } = await import('./route')

    const req = new Request('http://localhost/api/integrations', {
      method: 'POST',
      headers: {
        'x-internal-secret': 'my-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'test-hub',
        base_url: 'http://bh:8001/webhook/whatsapp/wacrm',
        events: ['message.received'],
        account_id: '00000000-0000-0000-0000-000000000001',
      }),
    })
    const resp = await POST(req)
    expect(resp.status).toBe(201)
    const body = await resp.json()
    expect(body.integration).toBeDefined()
    expect(body.api_key).toMatch(/^whsec_/)
    expect(mockedInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: '00000000-0000-0000-0000-000000000001',
        name: 'test-hub',
        bypassSsrf: true,
        secret: 'encrypted-secret',
      }),
    )
  })

  it('updates existing first-party integration without rotating its secret', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    mockedGetByName.mockResolvedValue(endpointRow({ id: 'existing-id' }) as never)
    mockedUpdate.mockResolvedValue(endpointRow({ id: 'existing-id' }) as never)
    const { POST } = await import('./route')

    const req = new Request('http://localhost/api/integrations', {
      method: 'POST',
      headers: {
        'x-internal-secret': 'my-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'test-hub',
        base_url: 'http://bh:8001/webhook/whatsapp/wacrm',
        events: ['message.received'],
        account_id: 'workspace-123',
      }),
    })
    const resp = await POST(req)
    expect(resp.status).toBe(201)
    const body = await resp.json()
    expect(body.api_key).toBe('existing-whsec')
    expect(mockedInsert).not.toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith(
      'workspace-123',
      'existing-id',
      expect.objectContaining({
        name: 'test-hub',
        bypass_ssrf: true,
      }),
    )
    expect(mockedUpdate.mock.calls[0][2]).not.toHaveProperty('secret')
  })

  it('returns 400 for missing name', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    const { POST } = await import('./route')

    const req = new Request('http://localhost/api/integrations', {
      method: 'POST',
      headers: {
        'x-internal-secret': 'my-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base_url: 'http://bh:8001/webhook',
        events: ['message.received'],
        account_id: '00000000-0000-0000-0000-000000000001',
      }),
    })
    const resp = await POST(req)
    expect(resp.status).toBe(400)
  })

  it('returns 401 without valid secret', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    const { POST } = await import('./route')

    const req = new Request('http://localhost/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test',
        base_url: 'http://bh:8001',
        events: ['message.received'],
        account_id: '00000000-0000-0000-0000-000000000001',
      }),
    })
    const resp = await POST(req)
    expect(resp.status).toBe(401)
  })
})

describe('DELETE /api/integrations', () => {
  it('deletes integration with valid params', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    mockedDelete.mockResolvedValue(true)
    const { DELETE } = await import('./route')

    const req = new Request(
      'http://localhost/api/integrations?account_id=00000000-0000-0000-0000-000000000001&name=test-hub',
      {
        method: 'DELETE',
        headers: { 'x-internal-secret': 'my-secret' },
      },
    )
    const resp = await DELETE(req)
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.ok).toBe(true)
  })

  it('returns 404 for missing integration', async () => {
    process.env.INTEGRATION_INTERNAL_SECRET = 'my-secret'
    mockedDelete.mockResolvedValue(false)
    const { DELETE } = await import('./route')

    const req = new Request(
      'http://localhost/api/integrations?account_id=not-found&name=missing',
      {
        method: 'DELETE',
        headers: { 'x-internal-secret': 'my-secret' },
      },
    )
    const resp = await DELETE(req)
    expect(resp.status).toBe(404)
  })
})
