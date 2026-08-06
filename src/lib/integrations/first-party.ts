// ============================================================
// First-party (business-hub) integration auth — thin adapter over
// `resolveBearerKey`.
//
// The real resolution lives in `@/lib/api-keys/auth` so the middleware
// and the config route share one code path: a `whsec_…` token is
// matched constant-time against the AES-256-GCM-encrypted secrets in
// `webhook_endpoints` (see `resolveBearerKey`). This module keeps the
// legacy `resolveFirstPartyAccountId(authorizationHeader)` signature so
// existing callers don't change.
// ============================================================

import { resolveBearerKey } from '@/lib/api-keys/auth';

export interface FirstPartyActor {
  accountId: string;
  endpointId: string;
}

/**
 * Resolve a first-party integration from its `whsec_…` bearer key.
 * Accepts the raw `Authorization` header value (legacy signature) and
 * delegates to `resolveBearerKey`. Returns null for anything else (no
 * header, wrong scheme/prefix, or no matching endpoint). Constant-time
 * matching is guaranteed by the underlying resolver.
 */
export async function resolveFirstPartyAccountId(
  authorizationHeader: string | null
): Promise<FirstPartyActor | null> {
  const request = new Request('https://internal', {
    headers: authorizationHeader ? { authorization: authorizationHeader } : {},
  });
  const resolved = await resolveBearerKey(request);
  if (!resolved || resolved.kind !== 'first_party') return null;
  return { accountId: resolved.accountId, endpointId: resolved.endpointId };
}
