import { NextResponse } from 'next/server'

import { toApiErrorResponse } from '@/lib/api/v1/respond'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { requireApiActor } from '@/lib/auth/api-context'
import type { AutomationTriggerType } from '@/types'

/**
 * Manual trigger for testing or for external integrations that want
 * to fire automations. Auth is required so the dispatch stays scoped
 * to the caller's account.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'admin')

    const body = await request.json().catch(() => null)
    if (!body?.trigger_type) {
      return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
    }

    await runAutomationsForTrigger({
      accountId: actor.accountId,
      triggerType: body.trigger_type as AutomationTriggerType,
      contactId: body.contact_id ?? null,
      context: body.context ?? {},
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
