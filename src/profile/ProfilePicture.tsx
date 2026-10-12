// "Profile picture" on your profile (#me): choose a photo, and the browser
// crops it square, shrinks it to 256 px WebP and uploads it to the public
// avatars bucket as <your user id>.webp. set_avatar then points
// players.avatar_version at it, so tables and profiles show it from the
// next connect (20261012000000_avatars.sql). It goes live at once; anyone
// signed in can report it from your public profile.
import { useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AVATAR_BUCKET,
  avatarPath,
  nextAvatarVersion,
  resizeToWebp,
} from '../lib/avatar'
import { PlayerAvatar } from '../net/Avatar'
import { AvatarBase } from '../net/avatarBase'

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; doing: string }
  | { kind: 'error'; message: string }

export function ProfilePicture({
  client,
  url,
  username,
  avatar: initial,
}: {
  client: SupabaseClient
  /** The Supabase project URL the picture loads from. */
  url: string
  username: string
  /** The current picture's bucket path, or null. */
  avatar: string | null
}) {
  const [avatar, setAvatar] = useState(initial)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const input = useRef<HTMLInputElement>(null)

  /** The signed-in account's id; the bucket's policies allow only its file. */
  async function userId() {
    const { data } = await client.auth.getSession()
    const id = data.session?.user.id
    if (!id) throw new Error('Sign in again to change your picture.')
    return id
  }

  async function upload(file: File) {
    setStatus({ kind: 'busy', doing: 'Uploading…' })
    try {
      const blob = await resizeToWebp(file)
      const id = await userId()
      const stored = await client.storage
        .from(AVATAR_BUCKET)
        .upload(`${id}.webp`, blob, {
          upsert: true,
          contentType: 'image/webp',
        })
      if (stored.error) throw new Error('The picture could not be uploaded.')
      const version = nextAvatarVersion()
      const set = await client.rpc('set_avatar', { p_version: version })
      if (set.error) throw new Error('The picture could not be saved.')
      setAvatar(avatarPath(id, version))
      setStatus({ kind: 'idle' })
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Something went wrong.',
      })
    }
  }

  async function remove() {
    setStatus({ kind: 'busy', doing: 'Removing…' })
    try {
      const id = await userId()
      const cleared = await client.rpc('remove_avatar')
      if (cleared.error) throw new Error('The picture could not be removed.')
      // The row no longer points at it; the file goes too, best effort.
      await client.storage.from(AVATAR_BUCKET).remove([`${id}.webp`])
      setAvatar(null)
      setStatus({ kind: 'idle' })
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Something went wrong.',
      })
    }
  }

  const busy = status.kind === 'busy'
  return (
    <section className="panel my-profile-picture" aria-labelledby="picture">
      <h2 id="picture">Profile picture</h2>
      <div className="my-profile-picture-row">
        <AvatarBase.Provider value={url}>
          <PlayerAvatar username={username} avatar={avatar} size={64} />
        </AvatarBase.Provider>
        <div className="my-profile-picture-actions">
          <p className="muted">
            {avatar
              ? 'Everyone sees it at your tables and on your public profile.'
              : 'Show a picture at your tables and on your public profile.'}
          </p>
          <div className="my-profile-picture-buttons">
            <button
              type="button"
              className="btn btn-outline"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {avatar ? 'Change picture' : 'Add a picture'}
            </button>
            {avatar && (
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy}
                onClick={() => void remove()}
              >
                Remove picture
              </button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            aria-label="Choose a picture"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Cleared, so choosing the same file again uploads again.
              e.target.value = ''
              if (file) void upload(file)
            }}
          />
          {status.kind === 'busy' && (
            <p className="muted" role="status">
              {status.doing}
            </p>
          )}
          {status.kind === 'error' && (
            <p className="muted" role="alert">
              {status.message}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
