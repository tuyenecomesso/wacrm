import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getSubscribedApps, verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { getConfigByAccount } from '@/lib/whatsapp/pg-config'

export async function GET(request: Request) {
  try {
    const actor = await requireApiActor(request, 'config:write')
    const config = await getConfigByAccount(actor.accountId)

    if (!config) {
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: 'No WhatsApp configuration saved yet.',
      })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token ?? '')
    } catch {
      return NextResponse.json({
        live: false,
        checks: {
          config_exists: true,
          token_decryptable: false,
        },
        message:
          "Stored access token can't be decrypted - likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
      })
    }

    const checks = {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: false,
      waba_subscribed_to_app: null as boolean | null,
      locally_marked_registered: config.registered_at != null,
    }
    const errors: string[] = []

    try {
      await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id ?? '',
        accessToken,
      })
      checks.phone_metadata_ok = true
    } catch (err) {
      errors.push(
        `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        })
        checks.waba_subscribed_to_app = subs.length > 0
        if (!checks.waba_subscribed_to_app) {
          errors.push(
            'WABA has no subscribed apps. Re-save the configuration to subscribe.',
          )
        }
      } catch (err) {
        errors.push(
          `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      errors.push(
        "No WABA ID on file - webhooks can't be wired without it. Add it in the form and re-save.",
      )
    }

    const live =
      checks.phone_metadata_ok &&
      (checks.waba_subscribed_to_app ?? false) &&
      checks.locally_marked_registered

    return NextResponse.json({
      live,
      checks,
      errors,
      last_registration_error: config.last_registration_error ?? null,
      registered_at: config.registered_at ?? null,
      subscribed_apps_at: config.subscribed_apps_at ?? null,
    })
  } catch (error) {
    console.error('Error in WhatsApp verify-registration GET:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
