import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getPool } from '@/lib/pg'
import {
  isLocalMediaBucket,
  LOCAL_MEDIA_MAX_BYTES,
  LocalMediaError,
  writeLocalMedia,
  detectMimeType,
  deleteLocalMedia,
} from '@/lib/storage/local'

export async function POST(request: Request) {
  try {
    const actor = await requireApiActor(request, 'messages:send')
    const formData = await request.formData()
    const bucket = String(formData.get('bucket') ?? '')
    const file = formData.get('file')

    if (!isLocalMediaBucket(bucket)) {
      return NextResponse.json({ error: 'invalid_bucket' }, { status: 400 })
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file_required' }, { status: 400 })
    }
    if (file.size > LOCAL_MEDIA_MAX_BYTES) {
      return NextResponse.json({ error: 'file_too_large' }, { status: 413 })
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const { id, path } = await writeLocalMedia({
      bucket,
      accountId: actor.accountId,
      fileName: file.name,
      bytes,
    })

    const url = new URL(`/api/whatsapp/media/${path}`, request.url).toString()
    if (bucket === 'chat-media') {
      await getPool().query(
        `INSERT INTO chat_media (id, account_id, path, url, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (path) DO UPDATE
           SET url = EXCLUDED.url,
               mime_type = EXCLUDED.mime_type,
               size_bytes = EXCLUDED.size_bytes`,
        [id, actor.accountId, path, url, detectMimeType(bytes), file.size],
      )
    }

    return NextResponse.json({ id, path, url }, { status: 201 })
  } catch (error) {
    if (error instanceof LocalMediaError) {
      return NextResponse.json({ error: error.code }, { status: error.status })
    }
    console.error('[whatsapp/media/upload POST] error:', error)
    return NextResponse.json({ error: 'internal_server_error' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireApiActor(request, 'messages:send')
    const body = (await request.json().catch(() => null)) as { path?: unknown } | null
    const targetPath = typeof body?.path === 'string' ? body.path : ''
    if (!targetPath.startsWith(`chat-media/${actor.accountId}/`)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    await deleteLocalMedia(targetPath)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof LocalMediaError) {
      return NextResponse.json({ error: error.code }, { status: error.status })
    }
    console.error('[whatsapp/media/upload DELETE] error:', error)
    return NextResponse.json({ error: 'internal_server_error' }, { status: 500 })
  }
}
