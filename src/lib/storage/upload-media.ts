/** 10 MB — local MEDIA_ROOT upload cap. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024

export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 10 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  document: 10 * 1024 * 1024,
} as const

export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  const hasExt = /\.[^.]+$/.test(fileName)
  const ext = hasExt ? fileName.split('.').pop()!.toLowerCase() : 'bin'
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 40) || 'file'
  return `account-${accountId}/${now}-${safeBase}.${ext}`
}

export interface UploadAccountMediaResult {
  publicUrl: string
  path: string
  id: string
}

export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const formData = new FormData()
  formData.set('bucket', bucket)
  formData.set('file', file)

  const response = await fetch('/api/whatsapp/media/upload', {
    method: 'POST',
    body: formData,
  })
  const data = (await response.json().catch(() => null)) as
    | { id?: string; path?: string; url?: string; error?: string }
    | null

  if (!response.ok || !data?.id || !data.path || !data.url) {
    throw new Error(data?.error ?? 'Upload failed')
  }

  return { id: data.id, path: data.path, publicUrl: data.url }
}

export async function deleteAccountMedia(
  _bucket: string,
  path: string,
): Promise<void> {
  const response = await fetch('/api/whatsapp/media/upload', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? 'Delete failed')
  }
}
