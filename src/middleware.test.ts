import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import {
  INTERNAL_ACCOUNT_HEADER,
  INTERNAL_CREATED_BY_HEADER,
  INTERNAL_ENDPOINT_HEADER,
  INTERNAL_KEY_HEADER,
  INTERNAL_SCOPES_HEADER,
} from '@/lib/auth/api-context'

const resolveBearerKey = vi.fn()
vi.mock('@/lib/api-keys/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-keys/auth')>(
    '@/lib/api-keys/auth'
  )
  return {
    ...actual,
    resolveBearerKey: (request: Request) => resolveBearerKey(request),
  }
})

const { proxy } = await import('./proxy')

beforeEach(() => {
  resolveBearerKey.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('middleware - bearer-key auth', () => {
  it('passes through deprecated UI routes without auth outside production', async () => {
    const res = await proxy(new NextRequest('https://app.test/dashboard'))
    expect(res.status).toBe(200)
    expect(resolveBearerKey).not.toHaveBeenCalled()
  })

  it('404s deprecated UI routes in production', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'

    try {
      const res = await proxy(new NextRequest('https://app.test/dashboard'))
      expect(res.status).toBe(404)
      expect(resolveBearerKey).not.toHaveBeenCalled()
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv
    }
  })

  it('allows the Meta webhook route without auth', async () => {
    const res = await proxy(
      new NextRequest('https://app.test/api/whatsapp/webhook')
    )
    expect(res.status).toBe(200)
    expect(resolveBearerKey).not.toHaveBeenCalled()
  })

  it('allows the internal integrations route without bearer auth', async () => {
    const res = await proxy(
      new NextRequest('https://app.test/api/integrations', {
        headers: { 'x-internal-secret': 'my-secret' },
      })
    )
    expect(res.status).toBe(200)
    expect(resolveBearerKey).not.toHaveBeenCalled()
  })

  it('returns missing_api_key for API routes without Authorization', async () => {
    const res = await proxy(new NextRequest('https://app.test/api/v1/me'))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'missing_api_key' })
  })

  it('returns invalid_api_key when the bearer token does not resolve', async () => {
    resolveBearerKey.mockResolvedValue(null)

    const res = await proxy(
      new NextRequest('https://app.test/api/v1/me', {
        headers: { authorization: 'Bearer not-a-real-key' },
      })
    )

    expect(resolveBearerKey).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_api_key' })
  })

  it('injects account, key, and scopes headers for API-key auth', async () => {
    resolveBearerKey.mockResolvedValue({
      kind: 'api_key',
      accountId: 'acct-1',
      keyId: 'key-1',
      scopes: ['messages:send', 'contacts:read'],
      createdBy: 'user-1',
    })

    const req = new NextRequest('https://app.test/api/v1/messages', {
      headers: { authorization: 'Bearer wacrm_live_example' },
    })
    const res = await proxy(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-override-headers')).toContain(
      INTERNAL_ACCOUNT_HEADER
    )
    expect(res.headers.get(`x-middleware-request-${INTERNAL_ACCOUNT_HEADER}`)).toBe(
      'acct-1'
    )
    expect(res.headers.get(`x-middleware-request-${INTERNAL_KEY_HEADER}`)).toBe(
      'key-1'
    )
    expect(
      res.headers.get(`x-middleware-request-${INTERNAL_CREATED_BY_HEADER}`)
    ).toBe('user-1')
    expect(res.headers.get(`x-middleware-request-${INTERNAL_SCOPES_HEADER}`)).toBe(
      'messages:send,contacts:read'
    )
    expect(
      res.headers.get(`x-middleware-request-${INTERNAL_ENDPOINT_HEADER}`)
    ).toBeNull()
  })

  it('injects account and endpoint headers for first-party whsec auth', async () => {
    resolveBearerKey.mockResolvedValue({
      kind: 'first_party',
      accountId: 'acct-bh-1',
      endpointId: 'endpoint-9',
    })

    const req = new NextRequest('https://app.test/api/whatsapp/config', {
      headers: { authorization: 'Bearer whsec_secret' },
    })
    const res = await proxy(req)

    expect(res.status).toBe(200)
    expect(res.headers.get(`x-middleware-request-${INTERNAL_ACCOUNT_HEADER}`)).toBe(
      'acct-bh-1'
    )
    expect(res.headers.get(`x-middleware-request-${INTERNAL_ENDPOINT_HEADER}`)).toBe(
      'endpoint-9'
    )
    expect(res.headers.get(`x-middleware-request-${INTERNAL_KEY_HEADER}`)).toBeNull()
    expect(
      res.headers.get(`x-middleware-request-${INTERNAL_CREATED_BY_HEADER}`)
    ).toBeNull()
    expect(
      res.headers.get(`x-middleware-request-${INTERNAL_SCOPES_HEADER}`)
    ).toBeNull()
  })
})
