import { NextResponse } from 'next/server'

import { requireApiActor } from '@/lib/auth/api-context'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getConfigByAccount } from '@/lib/whatsapp/pg-config'
import {
  isLocalMediaBucket,
  readLocalMedia,
  LocalMediaError,
} from '@/lib/storage/local'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const actor = await requireApiActor(request, 'messages:read')
    const { path } = await params

    if (path.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const [head, accountId] = path
    if (isLocalMediaBucket(head)) {
      if (accountId !== actor.accountId || path.some((part) => part === '..')) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }

      const relativePath = path.join('/')
      const { bytes, contentType } = await readLocalMedia(relativePath)
      return new Response(new Blob([bytes as unknown as BlobPart], { type: contentType }), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=0',
        },
      })
    }

    if (path.length !== 1) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const config = await getConfigByAccount(actor.accountId)
    if (!config?.access_token) {
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
    }

    const accessToken = decrypt(config.access_token)
    const mediaInfo = await getMediaUrl({ mediaId: head, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    if (error instanceof LocalMediaError) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    console.error('[whatsapp/media GET] error:', error)
    return NextResponse.json({ error: 'Failed to fetch media' }, { status: 500 })
  }
}
