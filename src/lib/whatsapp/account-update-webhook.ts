import { getConfigByWabaId, markConfigDisconnected } from './pg-config'

export function isAccountUpdateWebhookField(field: string): boolean {
  return field === 'account_update'
}

// Event names confirmed against Meta's account_update webhook reference:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
// These are the events that mean the WABA's connection to this app is no
// longer valid — everything else (business verification changes, pricing
// tier updates, etc) is audit-only and intentionally not handled here.
const DISCONNECT_EVENTS = new Set([
  'ACCOUNT_DELETED',
  'ACCOUNT_OFFBOARDED',
  'ACCOUNT_RESTRICTION',
  'ACCOUNT_VIOLATION',
  'DISABLED_UPDATE',
  'PARTNER_REMOVED',
  'PARTNER_APP_UNINSTALLED',
])

/**
 * Handles a single `account_update` change. Looks up the local config row
 * by WABA id and marks it disconnected when Meta reports the account lost
 * access. Fails safe: an unrecognized event or unknown waba_id is logged
 * and ignored, never throws (the caller's webhook ack must not depend on
 * this succeeding).
 *
 * `wabaId` must be `entry.id` — Meta puts the WABA id there for every
 * WhatsApp Business Platform webhook, account_update included, not nested
 * under `value`.
 */
export async function handleAccountUpdateChange(
  wabaId: string,
  value: { event?: string }
): Promise<void> {
  const event = value.event

  console.log(`[account_update] received event=${event} waba_id=${wabaId}`)

  if (!event || !DISCONNECT_EVENTS.has(event)) return

  if (!wabaId) {
    console.warn(`[account_update] event ${event} has no waba_id, ignoring`)
    return
  }

  const config = await getConfigByWabaId(wabaId)
  if (!config) {
    console.warn(`[account_update] unknown waba_id '${wabaId}', ignoring`)
    return
  }

  await markConfigDisconnected(config.account_id)
  console.warn(
    `[account_update] disconnected account_id=${config.account_id} (waba_id=${wabaId}) due to event ${event}`
  )
}
