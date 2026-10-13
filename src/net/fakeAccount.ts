// Test-only: the account's practice tables in memory (practice_hands,
// learning_state), with the database's own rules: a graded hand is never
// replaced by its provisional copy, the trainer document keeps the newer
// write, the curriculum is compare-and-set on its revision, the clear time
// only moves forward. `offline` makes every call
// fail, as a dropped connection does; `calls` records each write.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandRecord } from '../lib/storage'

type Learning = {
  trainer?: unknown
  trainer_updated_at?: string
  curriculum?: string
  curriculum_updated_at?: string
  /** As the database's trigger: a changed curriculum names old + 1. */
  curriculum_rev?: number
  curriculum_reset_at?: string
  hands_cleared_at?: string
}

export function fakeAccount({
  hands = [] as HandRecord[],
  learning = null as Learning | null,
} = {}) {
  const state = {
    hands: new Map(hands.map((h) => [h.id, h])),
    learning: learning ? { ...learning } : null,
    offline: false,
    calls: [] as string[],
    /**
     * While set, a hand upload waits for it before the account applies
     * it: a request still on its way (audit F08's overlap).
     */
    hold: null as Promise<void> | null,
  }
  const down = () => ({
    data: null,
    error: { message: 'Failed to fetch', code: '' },
  })
  const later = (iso: string | undefined, than: string | undefined) =>
    !than || (!!iso && Date.parse(iso) >= Date.parse(than))

  const practiceHands = () => {
    let limit = Infinity
    const read = () => {
      if (state.offline) return down()
      const rows = [...state.hands.values()]
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, limit)
        .map((record) => ({ record }))
      return { data: rows, error: null }
    }
    const query = {
      select: () => query,
      order: () => query,
      limit: (n: number) => {
        limit = n
        return query
      },
      then: (resolve: (value: ReturnType<typeof read>) => void) =>
        resolve(read()),
      upsert: async (rows: { id: string; record: HandRecord }[]) => {
        if (state.offline) return down()
        state.calls.push(`hands:${rows.map((r) => r.id).join(',')}`)
        if (state.hold) await state.hold
        for (const { id, record } of rows) {
          const old = state.hands.get(id)
          if (old && old.graded !== false && record.graded === false) continue
          state.hands.set(id, record)
        }
        return { error: null }
      },
      delete: () => ({
        lte: async (_: string, iso: string) => {
          if (state.offline) return down()
          state.calls.push(`clear:${iso}`)
          for (const [id, h] of state.hands)
            if ((h.at ?? 0) <= Date.parse(iso)) state.hands.delete(id)
          return { error: null }
        },
      }),
    }
    return query
  }

  const learningState = () => {
    const query = {
      select: () => query,
      maybeSingle: async () =>
        state.offline ? down() : { data: state.learning, error: null },
      upsert: async (row: Learning & { user_id: string }) => {
        if (state.offline) return down()
        const keys = Object.keys(row).filter((k) => k !== 'user_id')
        state.calls.push(`learning:${keys.join(',')}`)
        const next: Learning = { ...(state.learning ?? {}) }
        if (
          'trainer' in row &&
          later(row.trainer_updated_at, next.trainer_updated_at)
        ) {
          next.trainer = row.trainer
          next.trainer_updated_at = row.trainer_updated_at
        }
        if ('curriculum' in row && row.curriculum !== next.curriculum) {
          // Compare-and-set on the revision (audit F09): a write based on an
          // older revision, or one that names none (an old client), is
          // refused, as the database does.
          const rev = next.curriculum_rev ?? 0
          if (state.learning && row.curriculum_rev !== rev + 1)
            return {
              error: { message: 'curriculum changed', code: '40001' },
            }
          next.curriculum = row.curriculum
          next.curriculum_updated_at = row.curriculum_updated_at
          next.curriculum_rev = state.learning
            ? rev + 1
            : (row.curriculum_rev ?? 0)
        }
        if (
          row.curriculum_reset_at &&
          later(row.curriculum_reset_at, next.curriculum_reset_at)
        )
          next.curriculum_reset_at = row.curriculum_reset_at
        if (
          row.hands_cleared_at &&
          later(row.hands_cleared_at, next.hands_cleared_at)
        )
          next.hands_cleared_at = row.hands_cleared_at
        state.learning = next
        return { error: null }
      },
    }
    return query
  }

  const client = {
    from: (table: string) =>
      table === 'practice_hands' ? practiceHands() : learningState(),
  } as unknown as SupabaseClient
  return { client, state }
}
