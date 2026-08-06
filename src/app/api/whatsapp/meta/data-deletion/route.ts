import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { parseMetaSignedRequest, SignedRequestError } from '@/lib/whatsapp/signed-request'

/**
 * Data Deletion Request URL registered in the Meta App Dashboard. Meta
 * requires a JSON response with `url` (a status page the user can check)
 * and `confirmation_code` (a unique id for the request).
 *
 * We don't hold PII keyed by Facebook user_id — WhatsApp business data is
 * keyed by account_id/waba_id, unrelated to the Facebook user who ran the
 * Embedded Signup — so there is nothing to delete against this identifier
 * and the request is treated as complete immediately. The confirmation
 * code is logged for manual audit/traceability if ever needed.
 */
export async function POST(request: Request) {
  const form = await request.formData()
  const signedRequest = form.get('signed_request')

  if (typeof signedRequest !== 'string') {
    return NextResponse.json({ error: 'missing signed_request' }, { status: 400 })
  }

  try {
    const data = parseMetaSignedRequest(signedRequest)
    const userId = typeof data.user_id === 'string' ? data.user_id : 'unknown'
    const confirmationCode = `del_${userId}_${crypto.randomBytes(8).toString('hex')}`

    console.warn(
      '[meta] data deletion request received for user_id=%s confirmation_code=%s',
      userId,
      confirmationCode
    )

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
    return NextResponse.json({
      url: `${baseUrl}/api/whatsapp/meta/data-deletion/status?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    })
  } catch (error) {
    if (error instanceof SignedRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
