// Making the identifiers of a live game (ADR amendment 2026-10-12, "Live
// games"): the code a person says aloud, and the handle the list shows. Both
// come from the CSPRNG alone, and neither is derived from the other or from
// the table's id: a list row that carried a gameId must reveal nothing that
// seats, and a code must not be guessable from anything public.
import { toHex } from '../../src/engine/deck'
import { GAME_CODE_ALPHABET, GAME_CODE_LENGTH } from '../../src/shared/gameCode'

const N = GAME_CODE_ALPHABET.length
/**
 * A byte b gives symbol `b % N`, which favours the first `256 % N` symbols
 * unless the top of the byte range is thrown away. Bytes from CUTOFF up are
 * discarded, so every symbol has exactly CUTOFF / N bytes that map to it.
 * Derived from the alphabet (248 at 31 symbols), never written as a number,
 * so a changed alphabet cannot silently bring the bias back.
 */
export const CUTOFF = 256 - (256 % N)

/** Fills the array it is given with random bytes, and returns it. */
export type RandomBytes = (bytes: Uint8Array) => Uint8Array
const csprng: RandomBytes = (bytes) => crypto.getRandomValues(bytes)

/**
 * Batches the generator draws before it gives up: with real bytes the chance
 * of one batch rejecting everything is nil, so reaching this means a source
 * that is not random, and it throws rather than loop on it.
 */
const MAX_BATCHES = 64

/** A new GAME_CODE_LENGTH-symbol code, uniform over the alphabet. */
export function newGameCode(rand: RandomBytes = csprng): string {
  let code = ''
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    // Twice the length: about one byte in 32 is thrown away, so one batch
    // nearly always completes the code.
    for (const b of rand(new Uint8Array(GAME_CODE_LENGTH * 2))) {
      if (b >= CUTOFF) continue
      code += GAME_CODE_ALPHABET[b % N]
      if (code.length === GAME_CODE_LENGTH) return code
    }
  }
  throw new Error('The random source gave no usable bytes')
}

/** A new list handle: 16 random bytes as 32 hex characters (GAME_ID_RE). */
export function newGameId(rand: RandomBytes = csprng): string {
  return toHex(rand(new Uint8Array(16)))
}

/** A new request id: 8 random bytes as 16 hex characters (REQUEST_ID_RE). */
export function newRequestId(rand: RandomBytes = csprng): string {
  return toHex(rand(new Uint8Array(8)))
}
