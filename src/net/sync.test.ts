import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEARNING_KEY as CURRICULUM_KEY,
  LEARNING_V1_KEY as CURRICULUM_V1_KEY,
} from '../curriculum/core/persistence'
import {
  DEFAULT_SETTINGS,
  emptyProgress,
  LEARNING_SAVED_EVENT,
  STORAGE_KEY,
} from '../lib/storage'
import type { HandRecord, Progress } from '../lib/storage'
import { fakeAccount } from './fakeAccount'
import {
  clearLocalPractice,
  LEARNING_BACKUP_KEY,
  LEARNING_KEY,
  LEARNING_V1_KEY,
  mergeHands,
  pickLearning,
  PracticeSync,
  reconcile,
} from './sync'
import type { AccountState } from './sync'

const ME = 'u-me'
const hand = (id: string, at: number, extra: Partial<HandRecord> = {}) =>
  ({
    id,
    hand: at,
    net: 10,
    result: 'won',
    guided: false,
    at,
    ...extra,
  }) as HandRecord
const account = (over: Partial<AccountState> = {}): AccountState => ({
  hands: [],
  trainer: null,
  trainerAt: null,
  clearedAt: null,
  curriculum: null,
  curriculumAt: null,
  ...over,
})
const progress = (over: Partial<Progress> = {}): Progress => ({
  ...emptyProgress(),
  ...over,
})

afterEach(() => vi.useRealTimers())

describe('mergeHands', () => {
  it('keeps each hand once, graded over provisional, the newest 100, oldest first', () => {
    const local = [hand('a', 1, { graded: false }), hand('b', 2)]
    const theirs = [hand('a', 1, { decisions: [] }), hand('c', 3)]
    const merged = mergeHands(local, theirs)
    expect(merged.map((h) => h.id)).toEqual(['a', 'b', 'c'])
    expect(merged[0].graded).toBeUndefined()
    const many = Array.from({ length: 150 }, (_, i) => hand(`h${i}`, i))
    expect(mergeHands(many, []).map((h) => h.id)[0]).toBe('h50')
  })

  it('drops hands from before the last clear', () => {
    expect(
      mergeHands([hand('a', 5)], [hand('b', 15)], 10).map((h) => h.id),
    ).toEqual(['b'])
  })
})

describe('reconcile', () => {
  const theirs = {
    settings: { ...DEFAULT_SETTINGS, mode: 'analyst' as const },
    lessons: ['equity' as const],
    onboarded: true,
    guidedComplete: true,
  }

  it('brings play from before signing in into the account', () => {
    const merged = reconcile(
      progress({ hands: [hand('local', 2)], lessons: ['variance'] }),
      account({ hands: [hand('mine', 1)], trainer: theirs }),
      ME,
      null,
    )
    expect(merged.owner).toBe(ME)
    expect(merged.hands.map((h) => h.id)).toEqual(['mine', 'local'])
    expect(merged.lessons.sort()).toEqual(['equity', 'variance'])
    expect(merged.settings.mode).toBe('analyst')
    expect(merged.onboarded).toBe(true)
  })

  it('keeps settings changed on this browser since they last agreed', () => {
    const local = progress({
      owner: ME,
      settings: { ...DEFAULT_SETTINGS, speed: 'fast' },
    })
    const agreed = {
      user: ME,
      doc: JSON.stringify({ ...theirs, settings: DEFAULT_SETTINGS }),
      at: 1,
    }
    expect(
      reconcile(local, account({ trainer: theirs }), ME, agreed).settings.speed,
    ).toBe('fast')
    // Unchanged here: the account's newer settings win.
    const same = progress({ owner: ME, ...theirs, settings: DEFAULT_SETTINGS })
    expect(
      reconcile(same, account({ trainer: theirs }), ME, {
        user: ME,
        doc: JSON.stringify({
          settings: DEFAULT_SETTINGS,
          lessons: theirs.lessons,
          onboarded: true,
          guidedComplete: true,
        }),
        at: 1,
      }).settings.mode,
    ).toBe('analyst')
  })

  it("sets another account's progress aside for this account's own", () => {
    const merged = reconcile(
      progress({
        owner: 'someone-else',
        hands: [hand('theirs', 1)],
        lessons: ['ranges'],
        settings: { ...DEFAULT_SETTINGS, theme: 'dark', mode: 'analyst' },
      }),
      account({ hands: [hand('mine', 2)] }),
      ME,
      null,
    )
    expect(merged.hands.map((h) => h.id)).toEqual(['mine'])
    expect(merged.lessons).toEqual([])
    expect(merged.settings.theme).toBe('dark')
    expect(merged.settings.mode).toBe(DEFAULT_SETTINGS.mode)
    expect(merged.owner).toBe(ME)
  })
})

describe('pickLearning', () => {
  const doc = (updatedAt: string, tag: string) =>
    JSON.stringify({ updatedAt, tag })

  it('keeps the newer curriculum and backs up the other', () => {
    const older = doc('2026-10-01T00:00:00Z', 'here')
    const newer = doc('2026-10-11T00:00:00Z', 'there')
    expect(
      pickLearning(
        older,
        { curriculum: newer, curriculumAt: Date.parse('2026-10-11') },
        ME,
        ME,
      ),
    ).toEqual({ kind: 'take', raw: newer, backup: older })
    expect(
      pickLearning(
        newer,
        { curriculum: older, curriculumAt: Date.parse('2026-10-01') },
        ME,
        null,
      ),
    ).toEqual({ kind: 'send' })
    expect(
      pickLearning(null, { curriculum: null, curriculumAt: null }, ME, null),
    ).toEqual({ kind: 'keep' })
  })

  it("replaces another account's curriculum without keeping it", () => {
    const theirs = doc('2026-10-11T00:00:00Z', 'other player')
    expect(
      pickLearning(
        theirs,
        { curriculum: null, curriculumAt: null },
        ME,
        'someone-else',
      ),
    ).toEqual({ kind: 'take', raw: null, backup: null })
  })

  it('uses the keys the curriculum saves under', () => {
    expect(LEARNING_KEY).toBe(CURRICULUM_KEY)
    expect(LEARNING_V1_KEY).toBe(CURRICULUM_V1_KEY)
  })
})

/** A sync over the fake account, with the app's progress as a variable. */
function harness(local: Progress, server = fakeAccount()) {
  let current = local
  const reloadLearning = vi.fn()
  const sync = new PracticeSync(server.client, ME, {
    merge: (update) => {
      current = update(current)
    },
    reloadLearning,
  })
  return {
    sync,
    server,
    reloadLearning,
    get progress() {
      return current
    },
    /** The app changed its progress (App's effect calls note). */
    change(update: (p: Progress) => Progress) {
      current = update(current)
      sync.note(current)
    },
    async start() {
      await sync.start()
      sync.note(current)
    },
  }
}

describe('PracticeSync', () => {
  it('imports hands no account owns, then marks them as the account’s', async () => {
    const h = harness(progress({ hands: [hand('a', 1), hand('b', 2)] }))
    await h.start()
    expect(h.progress.owner).toBe(ME)
    expect(await h.sync.flush(1000)).toBe(true)
    expect([...h.server.state.hands.keys()].sort()).toEqual(['a', 'b'])
    h.sync.stop()
  })

  it('never sends back the hands it pulled', async () => {
    const server = fakeAccount({ hands: [hand('x', 1), hand('y', 2)] })
    const h = harness(progress(), server)
    await h.start()
    await h.sync.flush(1000)
    expect(h.progress.hands.map((x) => x.id)).toEqual(['x', 'y'])
    expect(server.state.calls.filter((c) => c.startsWith('hands:'))).toEqual([])
    h.sync.stop()
  })

  it('sends a new hand, then its graded record, and retries while offline', async () => {
    const h = harness(progress())
    await h.start()
    h.server.state.offline = true
    h.change((p) => ({ ...p, hands: [hand('n', 5, { graded: false })] }))
    expect(await h.sync.flush(200)).toBe(false)
    expect(h.sync.pending()).toBe(true)
    h.server.state.offline = false
    h.change((p) => ({ ...p, hands: [hand('n', 5, { decisions: [] })] }))
    expect(await h.sync.flush(1000)).toBe(true)
    expect(h.server.state.hands.get('n')?.graded).toBeUndefined()
    // One send for the hand, not one per change.
    expect(h.server.state.calls.filter((c) => c === 'hands:n')).toHaveLength(1)
    h.sync.stop()
  })

  it('clears the history on the account too', async () => {
    const server = fakeAccount({ hands: [hand('old', 1)] })
    const h = harness(progress(), server)
    await h.start()
    h.change((p) => ({ ...p, hands: [], historyClearedAt: 10 }))
    expect(await h.sync.flush(1000)).toBe(true)
    expect(server.state.hands.size).toBe(0)
    expect(server.state.learning?.hands_cleared_at).toBe(
      new Date(10).toISOString(),
    )
    h.sync.stop()
  })

  it('sends changed settings and lessons', async () => {
    const h = harness(progress())
    await h.start()
    await h.sync.flush(1000)
    h.change((p) => ({ ...p, lessons: ['pot-odds'] }))
    expect(await h.sync.flush(1000)).toBe(true)
    expect(h.server.state.learning?.trainer).toMatchObject({
      lessons: ['pot-odds'],
    })
    h.sync.stop()
  })

  it('takes the newer curriculum from the account and reloads it', async () => {
    const older = JSON.stringify({ updatedAt: '2026-10-01T00:00:00Z' })
    const newer = JSON.stringify({ updatedAt: '2026-10-11T00:00:00Z' })
    localStorage.setItem(LEARNING_KEY, older)
    const h = harness(
      progress(),
      fakeAccount({
        learning: {
          curriculum: newer,
          curriculum_updated_at: '2026-10-11T00:00:00Z',
        },
      }),
    )
    await h.start()
    expect(localStorage.getItem(LEARNING_KEY)).toBe(newer)
    expect(localStorage.getItem(LEARNING_BACKUP_KEY)).toBe(older)
    expect(h.reloadLearning).toHaveBeenCalled()
    h.sync.stop()
  })

  it('sends the curriculum when it saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const h = harness(progress())
    await h.start()
    const saved = JSON.stringify({ updatedAt: '2026-10-11T09:00:00Z' })
    localStorage.setItem(LEARNING_KEY, saved)
    window.dispatchEvent(new Event(LEARNING_SAVED_EVENT))
    expect(h.sync.pending()).toBe(true)
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.server.state.learning?.curriculum).toBe(saved)
    expect(h.sync.pending()).toBe(false)
    h.sync.stop()
  })

  it('reads the account again until it can', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const server = fakeAccount({ hands: [hand('x', 1)] })
    server.state.offline = true
    const h = harness(progress(), server)
    await h.start()
    expect(h.progress.owner).toBeUndefined()
    server.state.offline = false
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.progress.hands.map((x) => x.id)).toEqual(['x'])
    h.sync.stop()
  })
})

describe('clearLocalPractice', () => {
  it("forgets this browser's practice, never the account's", () => {
    for (const key of [STORAGE_KEY, LEARNING_KEY, 'qp.pendingClaim'])
      localStorage.setItem(key, '{}')
    localStorage.setItem('qp.hadAccount', '1')
    clearLocalPractice()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(LEARNING_KEY)).toBeNull()
    expect(localStorage.getItem('qp.pendingClaim')).toBeNull()
    expect(localStorage.getItem('qp.hadAccount')).toBe('1')
  })
})
