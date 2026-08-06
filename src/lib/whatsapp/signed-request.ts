import crypto from 'node:crypto'

/**
 * Decodes and verifies a Meta `signed_request` (used by the Deauthorize
 * and Data Deletion Request callbacks — NOT the same mechanism as the
 * `X-Hub-Signature-256` header used on the main webhook).
 *
 * Format: `{base64url(HMAC-SHA256 sig)}.{base64url(JSON payload)}`,
 * signed with the App Secret.
 * https://developers.facebook.com/docs/apps/delete-data
 */
export function parseMetaSignedRequest(signedRequest: string): Record<string, unknown> {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    throw new SignedRequestError(500, 'META_APP_SECRET not configured')
  }

  const parts = signedRequest.split('.')
  if (parts.length !== 2) {
    throw new SignedRequestError(400, 'malformed signed_request')
  }
  const [encodedSig, payload] = parts

  let sig: Buffer
  let data: Record<string, unknown>
  try {
    sig = base64UrlDecode(encodedSig)
    data = JSON.parse(base64UrlDecode(payload).toString('utf-8'))
  } catch {
    throw new SignedRequestError(400, 'invalid signed_request')
  }

  if (String(data.algorithm ?? '').toUpperCase() !== 'HMAC-SHA256') {
    throw new SignedRequestError(400, 'unsupported signature algorithm')
  }

  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest()
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new SignedRequestError(400, 'invalid signature')
  }

  return data
}

export class SignedRequestError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function base64UrlDecode(data: string): Buffer {
  const padded = data + '='.repeat((4 - (data.length % 4)) % 4)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}
