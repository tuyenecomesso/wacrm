// ============================================================
// GET  /api/v1/webhooks — list webhook endpoints (scope: webhooks:manage)
// POST /api/v1/webhooks — register an endpoint    (scope: webhooks:manage)
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';
import {
  insertWebhookEndpoint,
  listWebhookEndpointsByAccount,
} from '@/lib/webhooks/pg-repo';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const data = await listWebhookEndpointsByAccount(ctx.accountId);

    return okList(
      data.map((row) => serializeWebhookEndpoint(row as unknown as Record<string, unknown>)),
      null
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const url = normalizeWebhookUrl(body.url);
    if (!url) {
      return fail('bad_request', "'url' must be a valid https:// URL", 400);
    }

    const events = normalizeEvents(body.events);
    if (!events) {
      return fail(
        'bad_request',
        "'events' must be a non-empty array of known event names",
        400
      );
    }

    const secret = generateWebhookSecret();
    const created = await insertWebhookEndpoint({
      accountId: ctx.accountId,
      createdBy: ctx.createdBy,
      url,
      name: typeof body.name === 'string' ? body.name.trim() || null : null,
      secret: encrypt(secret),
      events,
      bypassSsrf: false,
    });

    return ok(
      { ...serializeWebhookEndpoint(created as unknown as Record<string, unknown>), secret },
      201
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

