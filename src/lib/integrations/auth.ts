/**
 * Shared-secret auth for the internal integrations API.
 *
 * The `POST /api/integrations` endpoint is protected by an
 * `X-Internal-Secret` header that must match the
 * `INTEGRATION_INTERNAL_SECRET` env var. This is a simple shared
 * secret shared between wacrm and trusted first-party services
 * (e.g. business-hub).
 */

export function requireInternalSecret(request: Request): void {
  const expected = process.env.INTEGRATION_INTERNAL_SECRET;
  if (!expected) {
    throw new InternalAuthError(
      'INTEGRATION_INTERNAL_SECRET is not configured'
    );
  }

  const provided = request.headers.get('x-internal-secret');
  if (!provided || provided.trim() !== expected.trim()) {
    throw new InternalAuthError('Invalid or missing X-Internal-Secret');
  }
}

export class InternalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalAuthError';
  }
}
