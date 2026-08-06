import { NextResponse } from 'next/server'

import { requireApiActor, type ApiActorContext } from '@/lib/auth/api-context'
import { getAccountById } from '@/lib/db/repos/accounts'
import { getMemberRole } from '@/lib/db/repos/members'
import { hasMinRole, isAccountRole, type AccountRole } from '@/lib/auth/roles'

export class AccountAuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AccountAuthError'
    this.status = status
  }
}

export function toAccountErrorResponse(error: unknown): NextResponse {
  if (error instanceof AccountAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }

  console.error('[account-pg] uncategorized error:', error)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

export interface AccountRouteContext {
  actor: ApiActorContext
  accountId: string
  actingUserId: string | null
  role: AccountRole | null
  account: { id: string; name: string; owner_user_id: string | null } | null
}

export async function getAccountRouteContext(
  request: Request,
  scope: 'admin' | undefined = 'admin'
): Promise<AccountRouteContext> {
  const actor = await requireApiActor(request, scope)
  const actingUserId = actor.authType === 'api_key' ? actor.createdBy : null

  const account = await getAccountById(actor.accountId)
  let role: AccountRole | null = null

  if (actingUserId) {
    role = await getMemberRole(actor.accountId, actingUserId)
  }

  return {
    actor,
    accountId: actor.accountId,
    actingUserId,
    role,
    account,
  }
}

export async function requireAccountRole(
  request: Request,
  minRole: AccountRole
): Promise<AccountRouteContext> {
  const ctx = await getAccountRouteContext(request, 'admin')
  if (!ctx.role || !hasMinRole(ctx.role, minRole)) {
    throw new AccountAuthError(
      403,
      `This action requires the '${minRole}' role or higher`
    )
  }
  return ctx
}
