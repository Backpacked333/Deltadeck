// Deck layout and the per-slot deck commitment. The engine never shuffles on
// its own: the server shuffles with a CSPRNG through `shuffleWith` and passes
// the deck in. Commitment uses Web Crypto only, so the same code commits in
// the Worker and verifies in the browser.
//
//   salt_i     = HMAC-SHA256(handSecret, [i])[0..16]
//   leaf_i     = SHA-256(salt_i ‖ [card_i])
//   commitment = hex(SHA-256(leaf_0 ‖ … ‖ leaf_51))
//
// After a hand the server reveals every leaf plus (slot, card, salt) for the
// board and shown hole cards to everyone, and each seat's own two hole slots
// to that seat alone. HMAC is a PRF, so revealed salts say nothing about the
// slots that stay hidden, and a folded hand stays private to its player.
import { clockwiseFrom } from './positions'
import type { HandConfig, SeatId } from './types'

export const DECK_SIZE = 52
export const LEAF_BYTES = 32
const SALT_BYTES = 16

export const orderedDeck = () => Array.from({ length: DECK_SIZE }, (_, i) => i)

/** Fisher–Yates with an injected uniform integer source on [0, n). */
export function shuffleWith(randomInt: (n: number) => number) {
  const deck = orderedDeck()
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

/**
 * Which deck slot feeds which card. Hole cards go round-robin, one per pass,
 * starting at the first seat clockwise from the button; the board follows in
 * slots 2N..2N+4. There are no burn cards.
 */
export function dealSlots(config: HandConfig) {
  const order = clockwiseFrom(
    config.seats.map((s) => s.seat),
    config.button,
  )
  const n = order.length
  const holes: Record<SeatId, [number, number]> = {}
  order.forEach((seat, i) => (holes[seat] = [i, n + i]))
  const board = [0, 1, 2, 3, 4].map((i) => 2 * n + i)
  return { holes, board }
}

/** Valid card ids, all distinct; -1 (unknown) allowed when `partial`. */
export function isValidDeck(deck: number[], partial = false) {
  if (deck.length !== DECK_SIZE) return false
  const seen = new Set<number>()
  for (const id of deck) {
    if (partial && id === -1) continue
    if (!Number.isInteger(id) || id < 0 || id >= DECK_SIZE || seen.has(id))
      return false
    seen.add(id)
  }
  return true
}

/**
 * A replay deck from public information: the board, shown hands and the
 * viewer's own cards. Every other slot is -1, which the engine never reads
 * because folded and unshown hands are never evaluated.
 */
export function deckFromRecord(
  config: HandConfig,
  board: number[],
  known: { seat: SeatId; cards: [number, number] }[],
) {
  const deck = Array<number>(DECK_SIZE).fill(-1)
  const slots = dealSlots(config)
  board.forEach((card, i) => (deck[slots.board[i]] = card))
  for (const { seat, cards } of known) {
    const [a, b] = slots.holes[seat]
    deck[a] = cards[0]
    deck[b] = cards[1]
  }
  return deck
}

// ---- Commitment --------------------------------------------------------------

const subtle = () => crypto.subtle
const bytes = (data: Uint8Array) => data as Uint8Array<ArrayBuffer>

async function sha256(data: Uint8Array) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes(data)))
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const toHex = (data: Uint8Array) =>
  Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')

export function fromHex(hex: string) {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('Invalid hex')
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))
}

export const toBase64 = (data: Uint8Array) =>
  btoa(Array.from(data, (b) => String.fromCharCode(b)).join(''))

export const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/**
 * Every slot's salt under `secret`: 52 HMACs. A hand's end needs them for the
 * commitment and for each opening, so it computes them once and passes them
 * on (`commitDeck` and `revealSlots` take them as their last argument); the
 * bytes are the same either way.
 */
export async function salts(secret: Uint8Array) {
  const key = await subtle().importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return Promise.all(
    orderedDeck().map(async (slot) =>
      new Uint8Array(
        await subtle().sign('HMAC', key, bytes(Uint8Array.of(slot))),
      ).slice(0, SALT_BYTES),
    ),
  )
}

const leafOf = (salt: Uint8Array, card: number) =>
  sha256(concat([salt, Uint8Array.of(card)]))

export type RevealedSlot = { slot: number; card: number; salt: string }

/**
 * Commits to every slot of `deck` under a fresh per-hand secret. `saltList`:
 * `salts(secret)` if the caller has it already.
 */
export async function commitDeck(
  deck: number[],
  secret: Uint8Array,
  saltList?: Uint8Array[],
) {
  if (!isValidDeck(deck)) throw new Error('Commitment needs a full deck')
  saltList ??= await salts(secret)
  const leaves = concat(
    await Promise.all(deck.map((card, i) => leafOf(saltList[i], card))),
  )
  return { commitment: toHex(await sha256(leaves)), leaves }
}

/**
 * The opening for chosen slots: their cards and salts. `saltList`:
 * `salts(secret)` if the caller has it already.
 */
export async function revealSlots(
  deck: number[],
  secret: Uint8Array,
  slots: number[],
  saltList?: Uint8Array[],
): Promise<RevealedSlot[]> {
  saltList ??= await salts(secret)
  return [...new Set(slots)]
    .sort((a, b) => a - b)
    .map((slot) => ({ slot, card: deck[slot], salt: toHex(saltList[slot]) }))
}

/** True when the leaves match the commitment and every slot opens its leaf. */
export async function verifyReveal(
  commitment: string,
  leaves: Uint8Array,
  slots: RevealedSlot[],
) {
  if (leaves.length !== DECK_SIZE * LEAF_BYTES) return false
  if (toHex(await sha256(leaves)) !== commitment) return false
  for (const { slot, card, salt } of slots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= DECK_SIZE) return false
    const leaf = await leafOf(fromHex(salt), card)
    const expected = leaves.subarray(slot * LEAF_BYTES, (slot + 1) * LEAF_BYTES)
    if (toHex(leaf) !== toHex(expected)) return false
  }
  return true
}

// ---- What a finished hand opens -------------------------------------------------

type PublicDeal = {
  config: HandConfig
  board: number[]
  shown: { seat: SeatId; cards: [number, number] }[]
}

/** Slot → card for everything a finished hand made public. */
function publicCards({ config, board, shown }: PublicDeal) {
  const slots = dealSlots(config)
  const cards = new Map<number, number>()
  board.forEach((card, i) => cards.set(slots.board[i], card))
  for (const { seat, cards: hole } of shown) {
    const [a, b] = slots.holes[seat]
    cards.set(a, hole[0])
    cards.set(b, hole[1])
  }
  return cards
}

/** The slots to reveal after a hand: the dealt board and shown hands only. */
export const publicSlots = (deal: PublicDeal) =>
  [...publicCards(deal).keys()].sort((a, b) => a - b)

/**
 * True when the reveal opens exactly the board and shown hands of `deal`,
 * from the slots the dealing order puts them in, under `commitment`. A
 * re-deal after the commitment, a swapped card or an extra opened slot
 * (someone's folded hand) all fail.
 */
export async function verifyDeal(
  commitment: string,
  leaves: Uint8Array,
  slots: RevealedSlot[],
  deal: PublicDeal,
) {
  const expected = publicCards(deal)
  // Each public slot opened exactly once: a repeated opening must not stand
  // in for a slot the server cannot open (a card changed after committing).
  const opened = new Set(slots.map((s) => s.slot))
  if (slots.length !== expected.size || opened.size !== expected.size)
    return false
  for (const { slot, card } of slots)
    if (expected.get(slot) !== card) return false
  return verifyReveal(commitment, leaves, slots)
}

/**
 * True when `own` opens exactly `seat`'s two hole slots, with the `cards`
 * that player was dealt, under `commitment`: the cards a player held (folded
 * or not) were the committed ones. Each seat receives only its own opening.
 */
export async function verifyOwn(
  commitment: string,
  leaves: Uint8Array,
  own: RevealedSlot[],
  config: HandConfig,
  seat: SeatId,
  cards: [number, number],
) {
  const slots = dealSlots(config).holes[seat]
  if (!slots || own.length !== 2) return false
  const opened = new Map(own.map((s) => [s.slot, s.card]))
  if (
    opened.size !== 2 ||
    opened.get(slots[0]) !== cards[0] ||
    opened.get(slots[1]) !== cards[1]
  )
    return false
  return verifyReveal(commitment, leaves, own)
}
