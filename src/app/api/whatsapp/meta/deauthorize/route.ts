import { NextResponse } from 'next/server'
import { parseMetaSignedRequest, SignedRequestError } from '@/lib/whatsapp/signed-request'

/**
 * Deauthorize callback URL registered in the Meta App Dashboard
 * (Facebook Login for Business → Settings). Meta calls this, unauthenticated
 * by our own bearer scheme, when a user removes the app from their
 * Facebook/Instagram settings. We don't delete data here — that's the
 * Data Deletion flow below — just log the event for audit. The account's
 * `whatsapp_config` row is separately marked disconnected by the
 * `account_update` webhook (PARTNER_REMOVED / PARTNER_APP_UNINSTALLED),
 * which carries the WABA id needed to resolve the account; this callback
 * only gets a Facebook user_id, which we don't otherwise track.
 */
export async function POST(request: Request) {
  const form = await request.formData()
  const signedRequest = form.get('signed_request')

  if (typeof signedRequest !== 'string') {
    return NextResponse.json({ error: 'missing signed_request' }, { status: 400 })
  }

  try {
    const data = parseMetaSignedRequest(signedRequest)
    console.warn('[meta] deauthorize received for user_id=%s', data.user_id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof SignedRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
