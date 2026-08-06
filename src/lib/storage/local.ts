import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const LOCAL_MEDIA_MAX_BYTES = 10 * 1024 * 1024
export const LOCAL_MEDIA_BUCKETS = ['avatars', 'chat-media', 'flow-media'] as const

export type LocalMediaBucket = (typeof LOCAL_MEDIA_BUCKETS)[number]

export class LocalMediaError extends Error {
  readonly status: number
  readonly code: string

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'LocalMediaError'
    this.code = code
    this.status = status
  }
}

export function getMediaRoot(): string {
  const root = process.env.MEDIA_ROOT?.trim()
  if (!root) {
    throw new LocalMediaError('storage_unconfigured', 'MEDIA_ROOT is not configured', 503)
  }
  return path.resolve(root)
}

export function isLocalMediaBucket(value: string): value is LocalMediaBucket {
  return (LOCAL_MEDIA_BUCKETS as readonly string[]).includes(value)
}

export function sanitizeFilename(fileName: string): string {
  const trimmed = fileName.trim()
  const hasExt = /\.[^.]+$/.test(trimmed)
  const ext = hasExt ? trimmed.split('.').pop()!.toLowerCase() : 'bin'
  const base =
    trimmed
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 80) || 'file'
  return `${base}.${ext}`
}

export function buildMediaPath(
  accountId: string,
  fileName: string,
  id: string = randomUUID(),
): string {
  return `${accountId}/${id}-${sanitizeFilename(fileName)}`
}

function resolveStoragePath(relativePath: string): string {
  const root = getMediaRoot()
  const absolute = path.resolve(root, relativePath)
  if (!absolute.startsWith(root)) {
    throw new LocalMediaError('not_found', 'Media not found', 404)
  }
  return absolute
}

export async function writeLocalMedia(args: {
  bucket: LocalMediaBucket
  accountId: string
  fileName: string
  bytes: Uint8Array
}): Promise<{ id: string; path: string }> {
  const id = randomUUID()
  const relativePath = `${args.bucket}/${buildMediaPath(args.accountId, args.fileName, id)}`
  const absolutePath = resolveStoragePath(relativePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, args.bytes)
  return { id, path: relativePath.replace(/\\/g, '/') }
}

export async function readLocalMedia(relativePath: string): Promise<{
  bytes: Uint8Array
  contentType: string
}> {
  const bytes = new Uint8Array(await readFile(resolveStoragePath(relativePath)))
  return { bytes, contentType: detectMimeType(bytes) }
}

export async function deleteLocalMedia(relativePath: string): Promise<void> {
  await rm(resolveStoragePath(relativePath), { force: true })
}

export function detectMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 8) {
    const sig = [...bytes.slice(0, 8)]
    if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) {
      return 'image/png'
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === '%PDF') {
    return 'application/pdf'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
  ) {
    return 'video/mp4'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return 'audio/ogg'
  }
  return 'application/octet-stream'
}
