import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMetaSignedRequest, SignedRequestError } from './signed-request'

const SECRET = 'test-app-secret'

function buildSignedRequest(secret: string, payload: Record<string, unknown>): string {
  const b64url = (data: Buffer) =>
    data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest()
  return `${b64url(sig)}.${payloadB64}`
}

describe('parseMetaSignedRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts a validly signed request', () => {
    vi.stubEnv('META_APP_SECRET', SECRET)
    const payload = { algorithm: 'HMAC-SHA256', issued_at: 123, user_id: 'user-1' }

    const result = parseMetaSignedRequest(buildSignedRequest(SECRET, payload))

    expect(result).toEqual(payload)
  })

  it('rejects a tampered payload', () => {
    vi.stubEnv('META_APP_SECRET', SECRET)
    const [sig] = buildSignedRequest(SECRET, { algorithm: 'HMAC-SHA256', user_id: 'user-1' }).split('.')
    const tamperedPayload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'attacker' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(() => parseMetaSignedRequest(`${sig}.${tamperedPayload}`)).toThrow(SignedRequestError)
  })

  it('rejects malformed input with no dot separator', () => {
    vi.stubEnv('META_APP_SECRET', SECRET)
    expect(() => parseMetaSignedRequest('not-a-signed-request')).toThrow(SignedRequestError)
  })

  it('rejects a non-JSON payload', () => {
    vi.stubEnv('META_APP_SECRET', SECRET)
    const badPayload = Buffer.from('not-json').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const sig = crypto
      .createHmac('sha256', SECRET)
      .update(badPayload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(() => parseMetaSignedRequest(`${sig}.${badPayload}`)).toThrow(SignedRequestError)
  })

  it('rejects an unsupported algorithm', () => {
    vi.stubEnv('META_APP_SECRET', SECRET)
    expect(() =>
      parseMetaSignedRequest(buildSignedRequest(SECRET, { algorithm: 'MD5', user_id: 'user-1' }))
    ).toThrow(SignedRequestError)
  })

  it('rejects when META_APP_SECRET is not configured', () => {
    vi.stubEnv('META_APP_SECRET', '')
    expect(() =>
      parseMetaSignedRequest(buildSignedRequest('anything', { algorithm: 'HMAC-SHA256' }))
    ).toThrow(SignedRequestError)
  })
})
