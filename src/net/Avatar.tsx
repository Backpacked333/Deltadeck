// A player's picture and school crest, beside their name at a table and on
// profiles. The picture's URL needs the Supabase project's address, which
// LiveApp knows once the account client loads; it hands it down in
// AvatarBase, so a plate shows the initial until then (and in tests).
import { useContext, useState } from 'react'
import { avatarUrl } from '../lib/avatar'
import { crestFor } from '../lib/crests'
import { AvatarBase } from './avatarBase'

/**
 * The picture in a circle, or the name's initial when there is none or it
 * fails to load. The name is always beside it, so the image is decoration
 * (alt="").
 */
export function PlayerAvatar({
  username,
  avatar,
  size = 24,
  className = '',
}: {
  username: string
  /** The bucket path from the server (MatchInfo.players[].avatar). */
  avatar?: string | null
  size?: number
  className?: string
}) {
  const base = useContext(AvatarBase)
  const src = avatarUrl(base, avatar)
  // Keyed by the URL: a new picture gets a fresh try after a failed one.
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <span
      className={`player-avatar ${className}`.trim()}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      aria-hidden="true"
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(src)}
        />
      ) : (
        username.charAt(0).toUpperCase()
      )}
    </span>
  )
}

/**
 * The crest of a player's verified school, when it is one we have a crest
 * for; nothing otherwise. Its tooltip and accessible name are the school's.
 */
export function SchoolCrest({
  school,
  size = 16,
}: {
  school?: string | null
  size?: number
}) {
  const crest = crestFor(school)
  if (!crest) return null
  return (
    <img
      className="school-crest"
      src={crest.src}
      alt={crest.name}
      title={crest.name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  )
}
