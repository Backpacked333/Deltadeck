// Every hand the account holds, for the portrait: all its practice hands
// (practice_hands; the browser keeps only the latest 100), and every hand of
// every online match it sat in that is over (match_players, matches, hands),
// with the player's own hole cards (hand_holes) and rated grades
// (hand_grades), both readable by the player alone. Each read is paged, so
// no history is too long to read; a part that fails is left out and named,
// and the rest still loads.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandRecord } from '../../lib/storage'
import type { HandRecordV1, MatchKind } from '../../shared/protocol'
import { fromOnline, fromPractice } from './hands'
import type { OnlineGrade, PlayedHand } from './hands'

/** Rows per request (PostgREST's default ceiling). */
export const PAGE = 1000
/** Ids per `in` filter, to keep request URLs short. */
export const CHUNK = 100

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>

/**
 * Every row, a page at a time, until a short page. Each read orders by a
 * unique key, so no row moves between pages.
 */
async function paged<T>(
  read: (from: number, to: number) => Page<T>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE) return rows
  }
}

const chunks = <T>(items: T[], size = CHUNK) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  )

const graded = (h: HandRecord) => h.graded !== false

/** The account's practice hands and this browser's, one copy of each. */
export async function practiceHands(
  client: SupabaseClient,
  userId: string,
  local: HandRecord[],
) {
  const rows = await paged<{ record: HandRecord }>((from, to) =>
    client
      .from('practice_hands')
      .select('record')
      .eq('user_id', userId)
      .order('played_at')
      .order('id')
      .range(from, to),
  )
  const byId = new Map<string, HandRecord>()
  for (const { record } of rows) byId.set(record.id, record)
  // This browser may hold hands not synced yet, or graded since.
  for (const h of local) {
    const stored = byId.get(h.id)
    if (!stored || (graded(h) && !graded(stored))) byId.set(h.id, h)
  }
  return [...byId.values()]
}

export async function onlineHands(
  client: SupabaseClient,
  userId: string,
): Promise<PlayedHand[]> {
  const seats = await paged<{ match_id: string }>((from, to) =>
    client
      .from('match_players')
      .select('match_id')
      .eq('user_id', userId)
      .order('match_id')
      .range(from, to),
  )
  const ids = [...new Set(seats.map((s) => s.match_id))]
  if (!ids.length) return []
  const kinds = new Map<string, MatchKind>()
  for (const chunk of chunks(ids)) {
    const { data, error } = await client
      .from('matches')
      .select('id, kind, status')
      .in('id', chunk)
    if (error) throw error
    for (const m of (data ?? []) as {
      id: string
      kind: MatchKind
      status: string
    }[])
      if (m.status !== 'playing') kinds.set(m.id, m.kind)
  }
  const over = [...kinds.keys()]
  if (!over.length) return []
  const [holes, grades] = await Promise.all([
    paged<{ hand_id: string; cards: number[] }>((from, to) =>
      client
        .from('hand_holes')
        .select('hand_id, cards')
        .eq('user_id', userId)
        .order('hand_id')
        .range(from, to),
    ),
    paged<{
      hand_id: string
      idx: number
      grade: OnlineGrade['grade']
      ev_lost: number
      accuracy: number
    }>((from, to) =>
      client
        .from('hand_grades')
        .select('hand_id, idx, grade, ev_lost, accuracy')
        .eq('user_id', userId)
        .order('hand_id')
        .order('idx')
        .range(from, to),
    ),
  ])
  const holeOf = new Map(holes.map((h) => [h.hand_id, h.cards]))
  const gradesOf = new Map<string, OnlineGrade[]>()
  for (const g of grades) {
    const list = gradesOf.get(g.hand_id) ?? []
    list.push({
      idx: g.idx,
      grade: g.grade,
      evLost: Number(g.ev_lost),
      accuracy: Number(g.accuracy),
    })
    gradesOf.set(g.hand_id, list)
  }
  const out: PlayedHand[] = []
  for (const chunk of chunks(over)) {
    const rows = await paged<{
      id: string
      match_id: string
      record: HandRecordV1
      created_at: string
    }>((from, to) =>
      client
        .from('hands')
        .select('id, match_id, record, created_at')
        .in('match_id', chunk)
        .order('id')
        .range(from, to),
    )
    for (const r of rows) {
      const hand = fromOnline(r.record, userId, kinds.get(r.match_id)!, {
        at: Date.parse(r.created_at) || 0,
        hole: holeOf.get(r.id),
        grades: gradesOf.get(r.id),
      })
      if (hand) out.push(hand)
    }
  }
  return out
}

export type EveryHand = {
  hands: PlayedHand[]
  /** Parts that could not be read; the portrait is drawn without them. */
  missing: ('practice' | 'online')[]
}

/**
 * Every hand: the account's when signed in (`userId`), else this browser's
 * practice hands alone.
 */
export async function loadEveryHand(
  client: SupabaseClient | null,
  userId: string | null,
  local: HandRecord[],
): Promise<EveryHand> {
  const missing: EveryHand['missing'] = []
  let practice = local
  let online: PlayedHand[] = []
  if (client && userId) {
    const [p, o] = await Promise.allSettled([
      practiceHands(client, userId, local),
      onlineHands(client, userId),
    ])
    if (p.status === 'fulfilled') practice = p.value
    else missing.push('practice')
    if (o.status === 'fulfilled') online = o.value
    else missing.push('online')
  }
  const hands = [
    ...practice.map(fromPractice).filter((h): h is PlayedHand => h !== null),
    ...online,
  ]
  return { hands, missing }
}
