import { NextResponse, type NextRequest } from 'next/server'

import { extractBearerToken, resolveBearerKey } from '@/lib/api-keys/auth'
import type { ResolvedBearerKey } from '@/lib/api-keys/auth'
import {
  INTERNAL_ACCOUNT_HEADER,
  INTERNAL_CREATED_BY_HEADER,
  INTERNAL_ENDPOINT_HEADER,
  INTERNAL_KEY_HEADER,
  INTERNAL_SCOPES_HEADER,
} from '@/lib/auth/api-context'

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function isWebhookChallengeRoute(pathname: string): boolean {
  return pathname === '/api/whatsapp/webhook'
}

function isInternalIntegrationRoute(pathname: string): boolean {
  return pathname === '/api/integrations'
}

function withInjectedHeaders(
  request: NextRequest,
  resolved: ResolvedBearerKey
): NextResponse {
  const headers = new Headers(request.headers)

  headers.set(INTERNAL_ACCOUNT_HEADER, resolved.accountId)

  if (resolved.kind === 'api_key') {
    headers.set(INTERNAL_KEY_HEADER, resolved.keyId)
    if (resolved.createdBy) {
      headers.set(INTERNAL_CREATED_BY_HEADER, resolved.createdBy)
    } else {
      headers.delete(INTERNAL_CREATED_BY_HEADER)
    }
    headers.set(INTERNAL_SCOPES_HEADER, resolved.scopes.join(','))
    headers.delete(INTERNAL_ENDPOINT_HEADER)
  } else {
    headers.set(INTERNAL_ENDPOINT_HEADER, resolved.endpointId)
    headers.delete(INTERNAL_KEY_HEADER)
    headers.delete(INTERNAL_CREATED_BY_HEADER)
    headers.delete(INTERNAL_SCOPES_HEADER)
  }

  return NextResponse.next({
    request: {
      headers,
    },
  })
}

function unauthorized(code: 'missing_api_key' | 'invalid_api_key'): NextResponse {
  return NextResponse.json({ error: code }, { status: 401 })
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (!isApiRoute(pathname)) {
    if (isProduction()) {
      return new NextResponse('Not Found', { status: 404 })
    }
    return NextResponse.next()
  }

  if (
    isWebhookChallengeRoute(pathname) ||
    isInternalIntegrationRoute(pathname)
  ) {
    return NextResponse.next()
  }

  const token = extractBearerToken(request)
  if (!token) {
    return unauthorized('missing_api_key')
  }

  const resolved = await resolveBearerKey(request)
  if (!resolved) {
    return unauthorized('invalid_api_key')
  }

  return withInjectedHeaders(request, resolved)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
