import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AVATAR_SIZE,
  avatarPath,
  avatarUrl,
  MAX_INPUT_BYTES,
  nextAvatarVersion,
  resizeToWebp,
} from './avatar'

const ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'

describe('avatarUrl', () => {
  it('builds the public bucket URL for a path the server sends', () => {
    expect(avatarUrl('https://x.supabase.co/', avatarPath(ID, 17))).toBe(
      `https://x.supabase.co/storage/v1/object/public/avatars/${ID}.webp?v=17`,
    )
  })

  it('gives nothing without a project URL or for any other path', () => {
    expect(avatarUrl('', avatarPath(ID, 1))).toBeNull()
    expect(avatarUrl('https://x.supabase.co', null)).toBeNull()
    for (const path of [
      `${ID}.png?v=1`,
      `../${ID}.webp?v=1`,
      `${ID}.webp`,
      'https://evil.example/x.webp?v=1',
    ])
      expect(avatarUrl('https://x.supabase.co', path)).toBeNull()
  })

  it('picks versions within the column range', () => {
    for (const now of [0, Date.now(), 8.64e15])
      expect(nextAvatarVersion(now)).toBeGreaterThanOrEqual(1)
    expect(nextAvatarVersion(8.64e15)).toBeLessThanOrEqual(1e9)
    expect(nextAvatarVersion(5000)).not.toBe(nextAvatarVersion(9000))
  })
})

describe('resizeToWebp', () => {
  afterEach(() => vi.unstubAllGlobals())

  const photo = (size = 10, type = 'image/jpeg') =>
    new File([new Uint8Array(size)], 'me.jpg', { type })

  /** A browser that decodes a 400×300 photo and encodes `out`. */
  function browser(out: Blob | null) {
    const close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 400, height: 300, close })),
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((done) => done(out))
    return { drawImage, toBlob, close }
  }

  it('refuses what is not an image, or too large, before decoding', async () => {
    const { drawImage } = browser(new Blob([], { type: 'image/webp' }))
    await expect(resizeToWebp(photo(10, 'application/pdf'))).rejects.toThrow(
      /image file/,
    )
    await expect(resizeToWebp(photo(MAX_INPUT_BYTES + 1))).rejects.toThrow(
      /over 5 MB/,
    )
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('crops the centre square and encodes 256 px WebP', async () => {
    const webp = new Blob(['x'], { type: 'image/webp' })
    const { drawImage, toBlob, close } = browser(webp)
    expect(await resizeToWebp(photo())).toBe(webp)
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      300,
      300,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    )
    expect(toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/webp',
      0.85,
    )
    expect(close).toHaveBeenCalled()
  })

  it('says so when the browser cannot encode WebP', async () => {
    browser(null)
    await expect(resizeToWebp(photo())).rejects.toThrow(/cannot save WebP/)
    browser(new Blob([], { type: 'image/png' }))
    await expect(resizeToWebp(photo())).rejects.toThrow(/cannot save WebP/)
  })

  it('says so when the image cannot be read', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('bad')
      }),
    )
    await expect(resizeToWebp(photo())).rejects.toThrow(/could not be read/)
  })
})
