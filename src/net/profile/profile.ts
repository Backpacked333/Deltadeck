// A player's public profile (P1-15), read with the publishable key: every
// table here is public (players, ratings, rating_history, match_players).
// Only rated matches that were rated, so finished, are listed.
import type { SupabaseClient } from '@supabase/supabase-js'
import { avatarPath } from '../../lib/avatar'
import type { Outcome } from '../../shared/protocol'

/** Matches listed on the profile. */
export const RECENT = 20
/** Rating changes drawn in the graph, the latest ones. */
export const HISTORY = 500

export type ProfilePlayer = {
  userId: string
  username: string
  country: string | null
  bio: string
  createdAt: string
  /** The picture's path in the avatars bucket, or null for none. */
  avatar: string | null
  /** A verified school's email domain, or null. */
  school: string | null
}

export type ProfileRating = {
  rating: number
  rd: number
  matches: number
  wins: number
  draws: number
  abandoned: number
  lastMatchAt: string | null
}

export type RatingPoint = { at: string; rating: number; rd: number }

export type RecentMatch = {
  matchId: string
  finishedAt: string
  outcome: Outcome
  opponent: string | null
  before: number
  after: number
}

export type Profile = {
  player: ProfilePlayer
  rating: ProfileRating | null
  /** Oldest first, starting from the rating before the first change shown. */
  history: RatingPoint[]
  /** Newest first. */
  recent: RecentMatch[]
}

type HistoryRow = {
  kind: string
  match_id: string | null
  outcome: Outcome | null
  before_rating: number
  before_rd: number
  after_rating: number
  after_rd: number
  created_at: string
}

const fail = (error: unknown) => {
  if (error) throw error
}

/** Null when nobody has that username. */
export async function loadProfile(
  client: SupabaseClient,
  username: string,
): Promise<Profile | null> {
  const found = await client
    .from('players')
    .select(
      'user_id, username, country, bio, created_at, avatar_version, school_domain, school_verified_at',
    )
    .eq('username', username.toLowerCase())
    .maybeSingle<{
      user_id: string
      username: string
      country: string | null
      bio: string
      created_at: string
      avatar_version?: number | null
      school_domain?: string | null
      school_verified_at?: string | null
    }>()
  fail(found.error)
  if (!found.data) return null
  const p = found.data
  const userId = p.user_id

  const [rating, changes, latest] = await Promise.all([
    client
      .from('ratings')
      .select('rating, rd, matches, wins, draws, abandoned, last_match_at')
      .eq('user_id', userId)
      .eq('format', 'hu-duplicate')
      .maybeSingle<{
        rating: number
        rd: number
        matches: number
        wins: number
        draws: number
        abandoned: number
        last_match_at: string | null
      }>(),
    client
      .from('rating_history')
      .select(
        'kind, match_id, outcome, before_rating, before_rd, after_rating, after_rd, created_at',
      )
      .eq('user_id', userId)
      .eq('format', 'hu-duplicate')
      .order('created_at', { ascending: false })
      .limit(HISTORY),
    // The list is by when matches were played: a rating applied late (an
    // outbox retry) must not push a newer match off it.
    client
      .from('rating_history')
      .select('match_id, outcome, before_rating, after_rating, played_at')
      .eq('user_id', userId)
      .eq('format', 'hu-duplicate')
      .eq('kind', 'match')
      .order('played_at', { ascending: false })
      .limit(RECENT),
  ])
  fail(rating.error)
  fail(changes.error)
  fail(latest.error)
  // The graph follows the order the ratings changed in.
  const rows = (changes.data ?? []) as HistoryRow[]

  const oldestFirst = [...rows].reverse()
  const history: RatingPoint[] = oldestFirst.length
    ? [
        {
          at: oldestFirst[0].created_at,
          rating: Number(oldestFirst[0].before_rating),
          rd: Number(oldestFirst[0].before_rd),
        },
        ...oldestFirst.map((h) => ({
          at: h.created_at,
          rating: Number(h.after_rating),
          rd: Number(h.after_rd),
        })),
      ]
    : []

  const played = (
    (latest.data ?? []) as {
      match_id: string
      outcome: Outcome
      before_rating: number
      after_rating: number
      played_at: string
    }[]
  ).filter((h) => h.match_id && h.outcome)
  const ids = played.map((h) => h.match_id)
  let opponents = new Map<string, string>()
  if (ids.length) {
    const seats = await client
      .from('match_players')
      .select('match_id, user_id')
      .in('match_id', ids)
      .neq('user_id', userId)
    fail(seats.error)
    const seatRows = (seats.data ?? []) as {
      match_id: string
      user_id: string
    }[]
    const names = seatRows.length
      ? await client
          .from('players')
          .select('user_id, username')
          .in('user_id', [...new Set(seatRows.map((s) => s.user_id))])
      : { data: [], error: null }
    fail(names.error)
    const nameOf = new Map(
      ((names.data ?? []) as { user_id: string; username: string }[]).map(
        (n) => [n.user_id, n.username],
      ),
    )
    opponents = new Map(
      seatRows.map((s) => [s.match_id, nameOf.get(s.user_id) ?? '']),
    )
  }

  return {
    player: {
      userId,
      username: p.username,
      country: p.country,
      bio: p.bio,
      createdAt: p.created_at,
      avatar: p.avatar_version ? avatarPath(userId, p.avatar_version) : null,
      // The badge is a verified school's only, as at the table.
      school: p.school_verified_at ? (p.school_domain ?? null) : null,
    },
    rating: rating.data
      ? {
          rating: Number(rating.data.rating),
          rd: Number(rating.data.rd),
          matches: rating.data.matches,
          wins: rating.data.wins,
          draws: rating.data.draws,
          abandoned: rating.data.abandoned,
          lastMatchAt: rating.data.last_match_at,
        }
      : null,
    history,
    recent: played.map((h) => ({
      matchId: h.match_id,
      finishedAt: h.played_at,
      outcome: h.outcome,
      opponent: opponents.get(h.match_id) || null,
      before: Number(h.before_rating),
      after: Number(h.after_rating),
    })),
  }
}
