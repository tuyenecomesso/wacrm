import { timingSafeEqual } from 'node:crypto'

import { listBypassEndpointSecrets } from '@/lib/webhooks/pg-repo'
import { decrypt } from '@/lib/whatsapp/encryption'
import { WEBHOOK_SECRET_PREFIX } from '@/lib/webhooks/endpoints'

export interface FirstPartyActor {
  accountId: string
  endpointId: string
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Resolve a first-party integration from its `whsec_…` bearer key.
 *
 * The key is the plaintext webhook secret the business-hub received
 * once at registration (`POST /api/integrations`); it is stored
 * AES-256-GCM-encrypted in `webhook_endpoints`. Matches are
 * constant-time. Returns null for anything else (no header, wrong
 * scheme/prefix, or no matching endpoint).
 */
export async function resolveFirstPartyAccountId(
  authorizationHeader: string | null
): Promise<FirstPartyActor | null> {
  if (!authorizationHeader) return null

  const token = authorizationHeader.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length).trim()
    : null
  if (!token || !token.startsWith(WEBHOOK_SECRET_PREFIX)) return null

  const endpoints = await listBypassEndpointSecrets()
  for (const endpoint of endpoints) {
    let plaintext: string
    try {
      plaintext = decrypt(endpoint.secret)
    } catch {
      continue
    }
    if (safeEqual(plaintext, token)) {
      return { accountId: endpoint.account_id, endpointId: endpoint.id }
    }
  }
  return null
}
