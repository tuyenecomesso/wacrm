import { randomUUID } from 'node:crypto';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import {
  listActiveEndpointsForEvent,
  markWebhookEndpointDelivered,
  recordWebhookEndpointFailure,
  type EndpointDeliveryRow,
} from '@/lib/webhooks/pg-repo';
import type { WebhookEvent } from '@/lib/webhooks/events';

/** Per-endpoint HTTP timeout. Kept short — this runs in `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

/**
 * Deliver `event` (+ `data`) to every active endpoint of `accountId`
 * subscribed to it. Never throws.
 *
 * Endpoints with `bypass_ssrf = true` skip the SSRF guard — they are
 * first-party integrations (e.g. business-hub) whose URL may point to
 * internal / private addresses.
 */
export async function dispatchWebhookEvent(
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  try {
    const rows = await listActiveEndpointsForEvent(accountId, event);
    if (rows.length === 0) return;

    const payload = JSON.stringify({
      id: randomUUID(),
      event,
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data,
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    await Promise.allSettled(
      rows.map((row) => deliverOne(row, event, payload, tsSeconds))
    );
  } catch (err) {
    console.error('[webhooks] dispatch failed:', err);
  }
}

async function deliverOne(
  row: EndpointDeliveryRow,
  event: string,
  payload: string,
  tsSeconds: number
): Promise<void> {
  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address — UNLESS this is a first-party
  // integration (bypass_ssrf = true).
  if (!row.bypass_ssrf && !(await isDeliverableUrl(row.url))) {
    console.warn('[webhooks] refusing non-public delivery target for', row.id);
    await recordFailure(row);
    return;
  }

  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch (err) {
    console.error('[webhooks] secret decrypt failed for', row.id, err);
    await recordFailure(row);
    return;
  }

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wacrm-Event': event,
        'X-Wacrm-Webhook-Id': row.id,
        'X-Wacrm-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    await markWebhookEndpointDelivered(row.id);
  } catch (err) {
    console.warn(
      `[webhooks] delivery to ${row.id} failed:`,
      err instanceof Error ? err.message : err
    );
    await recordFailure(row);
  }
}

async function recordFailure(row: EndpointDeliveryRow): Promise<void> {
  try {
    await recordWebhookEndpointFailure(row.id, MAX_CONSECUTIVE_FAILURES);
  } catch (err) {
    console.error('[webhooks] record_webhook_failure failed for', row.id, err);
  }
}
