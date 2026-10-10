// A finished match's hands as anyone can read them (P1-15): the public
// archive (matches, match_players, hands). A hand record carries the board
// and the cards shown at showdown, never a hidden hand; a match still being
// played is not shown at all, so nobody can follow a live table from here.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SeatId } from '../engine/types'
import type {
  HandRecordV1,
  MatchEndReason,
  MatchKind,
  Outcome,
} from '../shared/protocol'

/**
 * One account in the match (a match_players row). `seat` is the last seat it
 * held: at a six table two accounts can share it, so it orders the header
 * and never says who played a hand.
 */
export type PublicSeat = {
  userId: string
  seat: SeatId
  username: string
  outcome: Outcome | null
}

/**
 * A hand and who sat where in it, from its own record.seats: seats are
 * reused and players join between hands, so only the hand knows.
 */
export type PublicHand = {
  record: HandRecordV1
  verified: boolean
  players: { seat: SeatId; username: string }[]
}

export type PublicMatch =
  | { status: 'playing' }
  | {
      status: 'finished' | 'void'
      kind: MatchKind
      finishedAt: string | null
      /** Why it ended (a void match says which way), when recorded. */
      reason: MatchEndReason | null
      seats: PublicSeat[]
      hands: PublicHand[]
    }

const fail = (error: unknown) => {
  if (error) throw error
}

/** Null when there is no such match. */
export async function loadPublicMatch(
  client: SupabaseClient,
  matchId: string,
): Promise<PublicMatch | null> {
  const match = await client
    .from('matches')
    .select('id, kind, status, finished_at, result')
    .eq('id', matchId)
    .maybeSingle<{
      id: string
      kind: MatchKind
      status: 'playing' | 'finished' | 'void'
      finished_at: string | null
      result: { reason?: MatchEndReason } | null
    }>()
  fail(match.error)
  if (!match.data) return null
  if (match.data.status === 'playing') return { status: 'playing' }

  const [seats, hands] = await Promise.all([
    client
      .from('match_players')
      .select('seat, user_id, outcome')
      .eq('match_id', matchId)
      .order('seat'),
    client
      .from('hands')
      .select('hand_no, record, verified')
      .eq('match_id', matchId)
      .order('hand_no'),
  ])
  fail(seats.error)
  fail(hands.error)
  const seatRows = (seats.data ?? []) as {
    seat: SeatId
    user_id: string
    outcome: Outcome | null
  }[]
  const handRows = (hands.data ?? []) as {
    record: HandRecordV1
    verified: boolean
  }[]
  // The accounts the hands name as well as the rows, since a hand is named
  // from its own record.seats. Heads-up, both name the same two accounts,
  // so this asks for exactly what it always did.
  const userIds = [
    ...new Set([
      ...seatRows.map((s) => s.user_id),
      ...handRows.flatMap((h) => h.record.seats.map((s) => s.userId)),
    ]),
  ]
  const names = userIds.length
    ? await client
        .from('players')
        .select('user_id, username')
        .in('user_id', userIds)
    : { data: [], error: null }
  fail(names.error)
  const nameOf = new Map(
    ((names.data ?? []) as { user_id: string; username: string }[]).map((n) => [
      n.user_id,
      n.username,
    ]),
  )
  return {
    status: match.data.status,
    kind: match.data.kind,
    finishedAt: match.data.finished_at,
    reason: match.data.result?.reason ?? null,
    seats: seatRows.map((s) => ({
      userId: s.user_id,
      seat: s.seat,
      username: nameOf.get(s.user_id) ?? 'A player',
      outcome: s.outcome,
    })),
    hands: handRows.map((h) => ({
      record: h.record,
      verified: !!h.verified,
      // The account's name now, as the header shows it; the name it sat
      // down with only when the account has no player row to read.
      players: h.record.seats.map((s) => ({
        seat: s.seat,
        username: nameOf.get(s.userId) ?? s.username,
      })),
    })),
  }
}
