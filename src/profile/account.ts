// What Your profile reads from the account: the public profile (rating,
// its history, recent matches), the player's school, and their claimed
// challenge scores (owner-only, by row-level security).
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadProfile } from '../net/profile/profile'
import type { Profile } from '../net/profile/profile'

export type ChallengeScore = {
  hand: string
  accuracy: number
  playedAt: string
}

export type AccountHistory = {
  profile: Profile
  school: string | null
  /** Best first. */
  challenges: ChallengeScore[]
}

/** Null when the account has no player row yet. */
export async function loadAccountHistory(
  client: SupabaseClient,
  username: string,
): Promise<AccountHistory | null> {
  const profile = await loadProfile(client, username)
  if (!profile) return null
  const userId = profile.player.userId
  const [school, scores] = await Promise.all([
    client
      .from('players')
      .select('school')
      .eq('user_id', userId)
      .maybeSingle<{ school: string | null }>(),
    client
      .from('challenge_scores')
      .select('hand, accuracy, played_at')
      .eq('user_id', userId)
      .order('accuracy', { ascending: false })
      .limit(10),
  ])
  if (school.error) throw school.error
  if (scores.error) throw scores.error
  return {
    profile,
    school: school.data?.school ?? null,
    challenges: (
      (scores.data ?? []) as {
        hand: string
        accuracy: number
        played_at: string
      }[]
    ).map((s) => ({
      hand: s.hand,
      accuracy: s.accuracy,
      playedAt: s.played_at,
    })),
  }
}
