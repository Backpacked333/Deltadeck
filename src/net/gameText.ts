// The words and shapes the open games page needs, apart from its components
// (so they can be tested, and shared, without a render).
import { GAME_CODE_LENGTH, normaliseCode } from '../shared/gameCode'

/** "open 3 min": the age of a listed game, to the minute. */
export function openFor(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'open under a minute'
  if (minutes < 60) return `open ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60
    ? `open ${hours} h ${minutes % 60} min`
    : `open ${hours} h`
}

/** What a field holds after typing: upper case, no spaces, `ABC-234`. */
export function codeFieldText(typed: string) {
  const clean = typed
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, GAME_CODE_LENGTH)
  const cut = Math.ceil(GAME_CODE_LENGTH / 2)
  return clean.length > cut
    ? `${clean.slice(0, cut)}-${clean.slice(cut)}`
    : clean
}

/**
 * Where a pasted or typed link goes: a table's own link (`#play/<id>`), or a
 * code's (`#join/CODE`). Null for anything else, which is read as a code.
 */
export function readLink(
  text: string,
): { play: string } | { code: string } | null {
  const play = text.match(
    /#play\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i,
  )
  if (play) return { play: play[1].toLowerCase() }
  const join = text.match(/#join\/([0-9A-Za-z-]{6,8})\b/)
  const code = join ? normaliseCode(join[1]) : null
  return code ? { code } : null
}
