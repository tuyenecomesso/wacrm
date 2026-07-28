import { afterEach, describe, expect, it, vi } from 'vitest'

interface MockChain {
  [key: string]: unknown
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  then: ReturnType<typeof vi.fn>
  _action?: string
}

function makeSupabaseMock() {
  function builder(table: string): MockChain {
    const chain = { _action: undefined } as MockChain

    chain.select = vi.fn(() => chain)
    chain.insert = vi.fn(() => chain)
    chain.delete = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.single = vi.fn(() => chain)
    chain.then = vi.fn((resolve: (v: unknown) => void) => {
      if (table === 'webhook_endpoints') {
        if (chain._action === 'insert') {
          resolve({ data: { id: 'new-id', name: 'test', url: 'http://bh/webhook', events: ['message.received'], is_active: true, failure_count: 0, created_at: new Date().toISOString() }, error: null })
        } else if (chain._action === 'delete') {
          resolve({ data: { id: 'deleted-id' }, error: null })
        } else {
          resolve({ data: null, error: null })
        }
      }
      return chain
    })

    chain.eq = vi.fn((col: string, val: unknown) => {
      if (col === 'account_id' && val === 'not-found') {
        chain.then = vi.fn((resolve: (v: unknown) => void) => {
          resolve({ data: null, error: { message: 'not found' } })
          return chain
        })
      }
      return chain
    })

    return chain
  }

  const client = {
    from: vi.fn((table: string) => {
      const b = builder(table)
      if (table === 'webhook_endpoints') {
        b.insert = vi.fn(() => {
          b._action = 'insert'
          return b
        })
        b.delete = vi.fn(() => {
          b._action = 'delete'
          return b
        })
      }
      return b
    }),
  }

  return client
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: makeSupabaseMock,
}))

const ENV_BACKUP = { ...process.env }

afterEach(() => {
  process.env = { ...ENV_BACKUP }
})

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
