import { NextResponse } from 'next/server';

import { requireInternalSecret, InternalAuthError } from '@/lib/integrations/auth';
import {
  deleteWebhookEndpointByAccountAndName,
  insertWebhookEndpoint,
} from '@/lib/webhooks/pg-repo';
import {
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';
import { normalizeEvents } from '@/lib/webhooks/events';
import { encrypt } from '@/lib/whatsapp/encryption';

/**
 * GET /api/integrations
 *
 * Lightweight connectivity check for first-party integrations.
 * Returns ``{ ok: true }`` after validating the ``X-Internal-Secret``
 * header. Used by business-hub's ``ping()``.
 */
export async function GET(request: Request) {
  try {
    requireInternalSecret(request);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InternalAuthError) {
      return NextResponse.json(
        { error: 'unauthorized', message: err.message },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: 'internal', message: 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/integrations
 *
 * Remove a first-party integration by ``account_id`` and ``name``.
 * Protected by the ``X-Internal-Secret`` header (shared secret).
 *
 * Query params: ``?account_id=<uuid>&name=<name>``
 *
 * Response 200: ``{ ok: true }``
 */
export async function DELETE(request: Request) {
  try {
    requireInternalSecret(request);

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('account_id');
    const name = searchParams.get('name');

    if (!accountId || !name) {
      return NextResponse.json(
        { error: 'bad_request', message: "'account_id' and 'name' query params are required" },
        { status: 400 }
      );
    }

    const deleted = await deleteWebhookEndpointByAccountAndName(accountId, name);

    if (!deleted) {
      return NextResponse.json(
        { error: 'not_found', message: 'No integration found for the given account_id and name' },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InternalAuthError) {
      return NextResponse.json(
        { error: 'unauthorized', message: err.message },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: 'internal', message: 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/integrations
 *
 * Register a first-party integration using Supabase (webhook_endpoints
 * table with `bypass_ssrf = true`). Protected by the `X-Internal-Secret`
 * header (shared secret).
 *
 * Request body:
 *   { "name": "business-hub-prod",
 *     "base_url": "http://host.docker.internal:8001/webhook/whatsapp/wacrm",
 *     "events": ["message.received"],
 *     "account_id": "<uuid>" }
 *
 * Response 201:
 *   { integration: { id, name, url, events, ... }, api_key: "whsec_..." }
 */
export async function POST(request: Request) {
  try {
    requireInternalSecret(request);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'bad_request', message: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const name = typeof body.name === 'string' && body.name.trim().length > 0
      ? body.name.trim()
      : null;
    if (!name) {
      return NextResponse.json(
        { error: 'bad_request', message: "'name' is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    const url = normalizeWebhookUrl(body.base_url, true);
    if (!url) {
      return NextResponse.json(
        { error: 'bad_request', message: "'base_url' must be a valid http:// or https:// URL" },
        { status: 400 }
      );
    }

    const events = normalizeEvents(body.events);
    if (!events) {
      return NextResponse.json(
        { error: 'bad_request', message: "'events' must be a non-empty array of known event names" },
        { status: 400 }
      );
    }

    const accountId = typeof body.account_id === 'string' && body.account_id.trim().length > 0
      ? body.account_id.trim()
      : null;
    if (!accountId) {
      return NextResponse.json(
        { error: 'bad_request', message: "'account_id' is required and must be a valid UUID" },
        { status: 400 }
      );
    }

    const apiKey = generateWebhookSecret();

    let row: Record<string, unknown>;
    try {
      row = {
        ...(await insertWebhookEndpoint({
          accountId,
          url,
          name,
          secret: encrypt(apiKey),
          events,
          bypassSsrf: true,
        })),
      };
    } catch (err) {
      console.error('[api/integrations] insert failed:', err);
      return NextResponse.json(
        { error: 'internal', message: 'Failed to create integration' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        integration: serializeWebhookEndpoint(row),
        api_key: apiKey,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof InternalAuthError) {
      return NextResponse.json(
        { error: 'unauthorized', message: err.message },
        { status: 401 }
      );
    }
    console.error('[api/integrations] unexpected error:', err);
    return NextResponse.json(
      { error: 'internal', message: 'Unexpected error' },
      { status: 500 }
    );
  }
}
