// The identifiers of a live game (ADR amendment 2026-10-12, "Live games").
// Pure, no DOM or Worker API: the Worker and the browser both import it.
//
//   code     6 characters a person can say aloud or type; a seat capability
//            like the table's link, so it is never listed.
//   gameId   32 hex characters; the list's handle. It can only ask the host
//            for a seat, never take one.
//   request  16 hex characters; names one join request to the host.
//
// None is derived from another or from the table's id.

/** 2-9 and A-Z without I, L and O: no 0/O, 1/I/L to mix up. */
export const GAME_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
/** About 29.7 bits at 31 symbols; one constant to raise (8 gives 39.6). */
export const GAME_CODE_LENGTH = 6
export const GAME_CODE_RE = new RegExp(
  `^[${GAME_CODE_ALPHABET}]{${GAME_CODE_LENGTH}}$`,
)
export const GAME_ID_RE = /^[0-9a-f]{32}$/
export const REQUEST_ID_RE = /^[0-9a-f]{16}$/
/** What a typed or pasted code may be before it is cleaned. */
export const CODE_INPUT_MAX = 16

/**
 * A code as typed: uppercased, spaces and hyphens dropped. Null when it is
 * not a code. Nothing is remapped (0, 1, I, L and O are not in the alphabet),
 * so a wrong guess is a wrong guess.
 */
export function normaliseCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > CODE_INPUT_MAX) return null
  const code = input.replace(/[\s-]/g, '').toUpperCase()
  return GAME_CODE_RE.test(code) ? code : null
}

/** 'ABC234' shown as 'ABC-234': split at the middle. */
export function formatCode(code: string): string {
  const cut = Math.ceil(code.length / 2)
  return `${code.slice(0, cut)}-${code.slice(cut)}`
}
