import { NextResponse } from 'next/server'

/** Status page for the confirmation_code issued by the data-deletion callback. */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get('code')
  if (!code) {
    return NextResponse.json({ error: 'missing code' }, { status: 400 })
  }
  return NextResponse.json({ confirmation_code: code, status: 'completed' })
}
