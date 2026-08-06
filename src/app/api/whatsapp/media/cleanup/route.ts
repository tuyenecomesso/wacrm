import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { cleanupLocalMedia } from '@/lib/storage/cleanup'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await cleanupLocalMedia()
    return NextResponse.json(result)
  } catch (error) {
    console.error('[whatsapp/media/cleanup GET] error:', error)
    return NextResponse.json({ error: 'cleanup_failed' }, { status: 500 })
  }
}
