import { resolveBearerKey } from '@/lib/api-keys/auth';
import { satisfiesScope, type ApiScope } from '@/lib/api-keys/scopes';
import { forbidden, rateLimited, unauthorized } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export const INTERNAL_ACCOUNT_HEADER = 'x-internal-account-id';
export const INTERNAL_KEY_HEADER = 'x-internal-key-id';
export const INTERNAL_CREATED_BY_HEADER = 'x-internal-created-by';
export const INTERNAL_ENDPOINT_HEADER = 'x-internal-endpoint-id';
export const INTERNAL_SCOPES_HEADER = 'x-internal-scopes';

export interface ApiKeyContext {
  authType: 'api_key';
  accountId: string;
  keyId: string;
  scopes: string[];
  createdBy: string | null;
}

export interface FirstPartyContext {
  authType: 'first_party';
  accountId: string;
  endpointId: string;
  scopes: null;
}

export type ApiActorContext = ApiKeyContext | FirstPartyContext;

function parseScopesHeader(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').filter(Boolean);
}

export function contextFromInternalHeaders(
  request: Request
): ApiActorContext | null {
  const accountId = request.headers.get(INTERNAL_ACCOUNT_HEADER);
  const keyId = request.headers.get(INTERNAL_KEY_HEADER);
  const createdBy = request.headers.get(INTERNAL_CREATED_BY_HEADER);
  const endpointId = request.headers.get(INTERNAL_ENDPOINT_HEADER);

  if (!accountId || (!keyId && !endpointId)) return null;

  if (endpointId) {
    return {
      authType: 'first_party',
      accountId,
      endpointId,
      scopes: null,
    };
  }

    return {
      authType: 'api_key',
      accountId,
      keyId: keyId!,
      scopes: parseScopesHeader(request.headers.get(INTERNAL_SCOPES_HEADER)),
      createdBy,
    };
  }

export async function requireApiActor(
  request: Request,
  scope?: ApiScope
): Promise<ApiActorContext> {
  const fromHeaders = contextFromInternalHeaders(request);
  if (fromHeaders) {
    requireScope(fromHeaders.scopes, scope);
    return fromHeaders;
  }

  const resolved = await resolveBearerKey(request);
  if (!resolved) {
    throw unauthorized();
  }

  if (resolved.kind === 'first_party') {
    requireScope(null, scope);
    return {
      authType: 'first_party',
      accountId: resolved.accountId,
      endpointId: resolved.endpointId,
      scopes: null,
    };
  }

  const limit = checkRateLimit(`apikey:${resolved.keyId}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  requireScope(resolved.scopes, scope);

  return {
    authType: 'api_key',
    accountId: resolved.accountId,
    keyId: resolved.keyId,
    scopes: resolved.scopes,
    createdBy: resolved.createdBy,
  };
}

export async function requireApiKey(
  request: Request,
  scope?: ApiScope
): Promise<ApiKeyContext> {
  const actor = await requireApiActor(request, scope);
  if (actor.authType !== 'api_key') {
    throw unauthorized();
  }
  return actor;
}

export function requireScope(
  granted: readonly string[] | null,
  required: ApiScope | undefined
): void {
  if (!required) return;
  if (!satisfiesScope(granted, required)) {
    throw forbidden(`This API key is missing the '${required}' scope`);
  }
}

export { hasScope } from '@/lib/api-keys/scopes';
