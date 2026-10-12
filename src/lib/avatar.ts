// Profile pictures. Each player has at most one, `<user id>.webp` in the
// public avatars bucket (supabase/migrations/20261012000000_avatars.sql),
// and players.avatar_version says which upload is current. Tables get the
// object's path from the server (`<user id>.webp?v=<n>`, MatchInfo); this
// turns it into a URL on the Supabase project the app already talks to.

/** The bucket, as the migration creates it. */
export const AVATAR_BUCKET = 'avatars'
/** The square the browser uploads, in pixels: twice a large plate's circle. */
export const AVATAR_SIZE = 256
/** Larger photos are refused before decoding them. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024

/** The object's path for an account and version, as a table frame names it. */
export const avatarPath = (userId: string, version: number) =>
  `${userId}.webp?v=${version}`

/**
 * The public URL of a picture path, or null when there is no project URL or
 * the path is not one the server sends (a uuid, .webp and a version).
 */
export function avatarUrl(
  supabaseUrl: string,
  path: string | null | undefined,
): string | null {
  if (!supabaseUrl || !path) return null
  if (!/^[0-9a-f-]{36}\.webp\?v=\d{1,10}$/.test(path)) return null
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${AVATAR_BUCKET}/${path}`
}

/** A new version for an upload: changes each time, within the column's range. */
export const nextAvatarVersion = (now = Date.now()) =>
  (Math.floor(now / 1000) % 999_999_999) + 1

/**
 * A photo as the square WebP the bucket takes: its centre cropped square,
 * scaled to AVATAR_SIZE. Throws an Error whose message can be shown as is.
 */
export async function resizeToWebp(file: Blob): Promise<Blob> {
  if (!file.type.startsWith('image/'))
    throw new Error('Choose an image file (a JPEG, PNG or WebP).')
  if (file.size > MAX_INPUT_BYTES)
    throw new Error('That image is over 100 MB. Choose a smaller one.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That image could not be read. Try another one.')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const context = canvas.getContext('2d')
  if (!context || side === 0) {
    bitmap.close()
    throw new Error('This browser could not resize the image.')
  }
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  )
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.85),
  )
  // Some browsers (older Safari) cannot encode WebP and give back a PNG,
  // which the bucket refuses: say so rather than upload it.
  if (!blob || blob.type !== 'image/webp')
    throw new Error(
      'This browser cannot save WebP images. Try another browser.',
    )
  return blob
}
