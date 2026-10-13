// Practice history on the account. The browser stays the copy the app reads
// and writes (quantpoker.progress.v2, quantpoker.learning.v2); a signed-in
// player's copy is merged with the account's when the session starts, and
// every change after that is sent to it (practice_hands, learning_state,
// 20261011100000_practice_history.sql), retried while offline.
//
// Whose progress is in this browser decides the merge: progress nobody owns
// (played before signing in) joins the account that signs in; the same
// account's is merged; another account's is set aside for this one's.
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_SETTINGS,
  emptyProgress,
  HAND_LIMIT,
  LEARNING_SAVED_EVENT as LEARNING_SAVED,
  LEGACY_KEY,
  sanitizeProgress,
  STORAGE_KEY,
} from '../lib/storage'
import type { HandRecord, Progress, Settings } from '../lib/storage'
import type { LessonId } from '../lib/storage'

/** The curriculum's keys (src/curriculum/core/persistence.ts). */
export const LEARNING_KEY = 'quantpoker.learning.v2'
export const LEARNING_V1_KEY = 'quantpoker.learning.v1'
/** Where a curriculum replaced by the account's newer copy is kept. */
export const LEARNING_BACKUP_KEY = 'quantpoker.learning.v2.backup'
/** Which account the curriculum in this browser belongs to. */
const LEARNING_OWNER_KEY = 'qp.learningOwner'
/** The trainer document as last agreed with the account, to merge three ways. */
const TRAINER_SYNCED_KEY = 'qp.sync.trainer'

/** The database's limits: larger rows are refused, so never sent. */
export const RECORD_MAX_BYTES = 8192
export const CURRICULUM_MAX_BYTES = 1_200_000
const BATCH = 100
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 300_000
const LEARNING_DEBOUNCE_MS = 2_000

export type TrainerDoc = {
  settings: Settings
  lessons: LessonId[]
  onboarded: boolean
  guidedComplete: boolean
}
export const trainerDoc = (p: Progress): TrainerDoc => ({
  settings: p.settings,
  lessons: p.lessons,
  onboarded: p.onboarded,
  guidedComplete: p.guidedComplete,
})

/** What the account holds, as read when the session starts. */
export type AccountState = {
  hands: HandRecord[]
  trainer: TrainerDoc | null
  trainerAt: number | null
  clearedAt: number | null
  curriculum: string | null
  curriculumAt: number | null
}

const bytes = (text: string) => new TextEncoder().encode(text).length
const time = (iso: unknown) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : null
}
const graded = (h: HandRecord) => h.graded !== false

/**
 * Both copies of the history as one: every hand once, by id; a graded copy
 * over a provisional one; nothing from before the last clear; the newest
 * HAND_LIMIT kept, oldest first.
 */
export function mergeHands(
  local: HandRecord[],
  account: HandRecord[],
  clearedAt?: number | null,
): HandRecord[] {
  const byId = new Map<string, HandRecord>()
  for (const hand of account) byId.set(hand.id, hand)
  for (const hand of local) {
    const theirs = byId.get(hand.id)
    byId.set(hand.id, theirs && graded(theirs) && !graded(hand) ? theirs : hand)
  }
  return [...byId.values()]
    .filter((h) => clearedAt == null || (h.at ?? 0) > clearedAt)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .slice(-HAND_LIMIT)
}

type TrainerSynced = { user: string; doc: string; at: number }

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage full or blocked: the account keeps the copy.
  }
}

/**
 * This browser's progress merged with the account's. `synced` is the trainer
 * document as last agreed with this account on this browser: whichever side
 * changed since wins its settings (this browser, if both did).
 */
export function reconcile(
  local: Progress,
  account: AccountState,
  userId: string,
  synced: TrainerSynced | null,
): Progress {
  const theirs = account.trainer
  if (local.owner && local.owner !== userId) {
    // Another account's progress: this account starts from its own, keeping
    // only how the page looks.
    return {
      ...emptyProgress(),
      settings: theirs?.settings ?? {
        ...DEFAULT_SETTINGS,
        theme: local.settings.theme,
      },
      lessons: theirs?.lessons ?? [],
      onboarded: theirs?.onboarded ?? false,
      guidedComplete: theirs?.guidedComplete ?? false,
      hands: mergeHands([], account.hands, account.clearedAt),
      owner: userId,
      ...(account.clearedAt ? { historyClearedAt: account.clearedAt } : {}),
    }
  }
  const clearedAt =
    Math.max(local.historyClearedAt ?? 0, account.clearedAt ?? 0) || null
  // Settings: this browser's when the account has none, or when this
  // account changed them here since they last agreed; otherwise the
  // account's (play before signing in takes the account's settings).
  const changedHere =
    !synced ||
    synced.user !== userId ||
    synced.doc !== JSON.stringify(trainerDoc(local))
  const settings =
    !theirs || (local.owner === userId && changedHere)
      ? local.settings
      : theirs.settings
  return {
    ...local,
    settings,
    lessons: [...new Set([...(theirs?.lessons ?? []), ...local.lessons])],
    onboarded: local.onboarded || !!theirs?.onboarded,
    guidedComplete: local.guidedComplete || !!theirs?.guidedComplete,
    hands: mergeHands(local.hands, account.hands, clearedAt),
    owner: userId,
    ...(clearedAt ? { historyClearedAt: clearedAt } : {}),
  }
}

/** The curriculum's own change time, from the document it saved. */
export function curriculumTime(raw: string | null) {
  if (!raw) return null
  try {
    return time((JSON.parse(raw) as { updatedAt?: unknown }).updatedAt)
  } catch {
    return null
  }
}

export type LearningChoice =
  | { kind: 'keep' }
  | { kind: 'send' }
  | { kind: 'take'; raw: string | null; backup: string | null }

/**
 * Which curriculum wins: another account's is replaced by this one's (no
 * backup: it is not this player's); otherwise the newer by its own change
 * time, the other kept as a backup when it is replaced.
 */
export function pickLearning(
  local: string | null,
  account: Pick<AccountState, 'curriculum' | 'curriculumAt'>,
  userId: string,
  owner: string | null,
): LearningChoice {
  if (owner && owner !== userId)
    return { kind: 'take', raw: account.curriculum, backup: null }
  if (local === account.curriculum) return { kind: 'keep' }
  if (!account.curriculum) return local ? { kind: 'send' } : { kind: 'keep' }
  if (!local) return { kind: 'take', raw: account.curriculum, backup: null }
  const ours = curriculumTime(local) ?? 0
  return (account.curriculumAt ?? 0) > ours
    ? { kind: 'take', raw: account.curriculum, backup: local }
    : { kind: 'send' }
}

type Hooks = {
  /** Applies a change to the app's progress (React's state updater). */
  merge: (update: (current: Progress) => Progress) => void
  /** Reloads the curriculum after its stored copy was replaced. */
  reloadLearning: () => void
}

const running: { sync: PracticeSync | null } = { sync: null }
/** The running sync, for the sign-out page to finish sending first. */
export const activeSync = () => running.sync

/**
 * What a flush could say of this browser's practice (audit F08, F10):
 * - saved: the account acknowledged the latest version of everything;
 * - pending: something is still on its way (offline, or a request failed);
 * - unverified: the account's copy was never read, so nothing here can be
 *   known to be on it;
 * - blocked: something will not go however long we wait (a hand or a
 *   curriculum over the database's size, the daily hand cap).
 */
export type SaveState = 'saved' | 'pending' | 'unverified' | 'blocked'

/**
 * Whether this browser holds practice worth keeping: hands, or curriculum
 * work (attempts, receipts, drafts, notes). An empty progress or an empty
 * store is not work, so signing out of a fresh browser asks nothing.
 */
export function hasLocalWork(): boolean {
  const progress = readJson<{ hands?: unknown }>(STORAGE_KEY)
  if (Array.isArray(progress?.hands) && progress.hands.length) return true
  const learning = readJson<Record<string, unknown>>(LEARNING_KEY)
  if (!learning) return false
  const listed = (key: string) =>
    Array.isArray(learning[key]) && (learning[key] as unknown[]).length > 0
  const noted = (key: string) =>
    typeof learning[key] === 'object' &&
    learning[key] !== null &&
    Object.values(learning[key] as object).some(
      (v) =>
        (typeof v === 'string' && v.trim() !== '') || typeof v === 'object',
    )
  return (
    listed('attempts') ||
    listed('receipts') ||
    noted('drafts') ||
    noted('unitNotes')
  )
}

/**
 * This browser's practice as one JSON document, for the player to keep
 * before a sign-out that would drop what the account does not hold.
 */
export function exportLocalPractice(): string {
  const read = (key: string) => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as unknown) : null
    } catch {
      return null
    }
  }
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      progress: read(STORAGE_KEY),
      curriculum: read(LEARNING_KEY),
    },
    null,
    2,
  )
}

/**
 * One signed-in player's sync, from the first pull until sign-out. The
 * app reports every progress change (`note`); what differs from the
 * account's copy is sent, in batches, retried with a growing wait.
 */
export class PracticeSync {
  /** Each hand as the account holds it (JSON), so only changes are sent. */
  private sent = new Map<string, string>()
  private sentTrainer: string | null = null
  private sentClear = 0
  private queue = new Set<string>()
  /** Hands too large for the account, by the JSON that was too large. */
  private blocked = new Map<string, string>()
  /** The curriculum is over the account's size and cannot be sent. */
  private learningBlocked = false
  private latest: Progress | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private stopped = false
  private capped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private wait = RETRY_MIN_MS
  private sending: Promise<void> | null = null
  private learningTimer: ReturnType<typeof setTimeout> | null = null
  private learningDirty = false

  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
    private readonly hooks: Hooks,
  ) {
    running.sync = this
    window.addEventListener('online', this.retryNow)
    window.addEventListener(LEARNING_SAVED, this.learningSaved)
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.learningTimer) clearTimeout(this.learningTimer)
    window.removeEventListener('online', this.retryNow)
    window.removeEventListener(LEARNING_SAVED, this.learningSaved)
    if (running.sync === this) running.sync = null
  }

  /** Reads the account's copy and merges this browser's into it, once. */
  start(): Promise<void> {
    if (this.ready) return Promise.resolve()
    this.starting ??= this.startOnce().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startOnce(): Promise<void> {
    const account = await this.pull()
    if (this.stopped) return
    if (!account) {
      this.schedule()
      return
    }
    for (const hand of account.hands)
      this.sent.set(hand.id, JSON.stringify(hand))
    this.sentTrainer = account.trainer ? JSON.stringify(account.trainer) : null
    this.sentClear = account.clearedAt ?? 0
    const synced = readJson<TrainerSynced>(TRAINER_SYNCED_KEY)
    this.hooks.merge((current) =>
      reconcile(current, account, this.userId, synced),
    )
    this.startLearning(account)
    this.ready = true
    // What the app will hold once its merge lands: noted now, so a flush
    // that had to make this first read itself (a sign-out) sends it
    // without waiting for the app to report it.
    if (this.latest)
      this.note(reconcile(this.latest, account, this.userId, synced))
  }

  /** The account's copy, or null when it cannot be read now. */
  private async pull(): Promise<AccountState | null> {
    try {
      return await this.read()
    } catch {
      return null
    }
  }

  private async read(): Promise<AccountState | null> {
    const [hands, state] = await Promise.all([
      this.client
        .from('practice_hands')
        .select('record')
        .order('played_at', { ascending: false })
        .limit(HAND_LIMIT),
      this.client
        .from('learning_state')
        .select(
          'trainer, trainer_updated_at, curriculum, curriculum_updated_at, hands_cleared_at',
        )
        .maybeSingle(),
    ])
    if (hands.error || state.error) return null
    const row = state.data as Record<string, unknown> | null
    const trainer = row?.trainer ? sanitizeProgress(row.trainer) : null
    return {
      hands: sanitizeProgress({
        hands: (hands.data as { record: unknown }[]).map((r) => r.record),
      }).hands,
      trainer: trainer ? trainerDoc(trainer) : null,
      trainerAt: time(row?.trainer_updated_at),
      clearedAt: time(row?.hands_cleared_at),
      curriculum:
        typeof row?.curriculum === 'string' ? (row.curriculum as string) : null,
      curriculumAt: time(row?.curriculum_updated_at),
    }
  }

  /** The app's progress changed: queue whatever the account lacks. */
  note(progress: Progress) {
    this.latest = progress
    if (!this.ready || this.stopped || progress.owner !== this.userId) return
    for (const hand of progress.hands) {
      const json = JSON.stringify(hand)
      if (this.sent.get(hand.id) !== json && this.blocked.get(hand.id) !== json)
        this.queue.add(hand.id)
    }
    if (this.queue.size || this.trainerChanged() || this.clearChanged())
      this.schedule(0)
  }

  /** Whether anything is still waiting to reach the account. */
  pending() {
    return (
      this.queue.size > 0 ||
      this.trainerChanged() ||
      this.clearChanged() ||
      this.learningDirty
    )
  }

  /**
   * Sends everything now, waiting at most `ms`, and says what came of it
   * (SaveState). Only `saved` means the account acknowledged the latest
   * version of everything here; the sign-out page asks before it drops
   * anything else. A sync whose first read of the account has not
   * succeeded tries it first: until it does, nothing is known to be saved.
   */
  async flush(ms: number): Promise<SaveState> {
    if (this.learningTimer) {
      clearTimeout(this.learningTimer)
      this.learningTimer = null
    }
    let done = false
    const attempt = async () => {
      await this.start()
      // A round can end with a newer version noted meanwhile: go again
      // until nothing is left, or a request fails (it throws).
      while (!done && this.saveState() === 'pending') {
        await this.send()
        if (this.learningDirty) await this.sendLearning()
      }
    }
    await Promise.race([
      attempt().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ])
    done = true
    return this.saveState()
  }

  /** What is true of this browser's practice on the account right now. */
  saveState(): SaveState {
    if (!this.ready) return 'unverified'
    if (
      (this.queue.size > 0 && !this.capped) ||
      this.trainerChanged() ||
      this.clearChanged() ||
      this.learningDirty
    )
      return 'pending'
    if (
      (this.capped && this.queue.size > 0) ||
      this.blocked.size > 0 ||
      this.learningBlocked
    )
      return 'blocked'
    return 'saved'
  }

  private trainerChanged() {
    return (
      !!this.latest &&
      this.latest.owner === this.userId &&
      JSON.stringify(trainerDoc(this.latest)) !== this.sentTrainer
    )
  }
  private clearChanged() {
    return (
      !!this.latest &&
      this.latest.owner === this.userId &&
      (this.latest.historyClearedAt ?? 0) > this.sentClear
    )
  }

  private retryNow = () => {
    this.wait = RETRY_MIN_MS
    this.schedule(0)
  }

  private schedule(delay = this.wait) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void (this.ready ? this.send() : this.start()).then(
        () => {
          this.wait = RETRY_MIN_MS
          if (this.pending()) this.schedule()
        },
        () => {
          this.wait = Math.min(this.wait * 2, RETRY_MAX_MS)
          this.schedule()
        },
      )
    }, delay)
  }

  /** One round of sending, never two at once. Throws when a request failed. */
  private send(): Promise<void> {
    const round =
      this.sending ??
      this.sendOnce().finally(() => {
        this.sending = null
      })
    this.sending = round
    return round
  }

  private async sendOnce(): Promise<void> {
    const progress = this.latest
    if (!progress || progress.owner !== this.userId) return
    if (this.clearChanged()) {
      const at = progress.historyClearedAt!
      const iso = new Date(at).toISOString()
      const removed = await this.client
        .from('practice_hands')
        .delete()
        .lte('played_at', iso)
      if (removed.error) throw removed.error
      const saved = await this.client
        .from('learning_state')
        .upsert(
          { user_id: this.userId, hands_cleared_at: iso },
          { onConflict: 'user_id' },
        )
      if (saved.error) throw saved.error
      this.sentClear = at
      for (const [id, json] of this.sent)
        if (((JSON.parse(json) as HandRecord).at ?? 0) <= at)
          this.sent.delete(id)
    }
    if (this.queue.size && !this.capped) {
      const byId = new Map(progress.hands.map((h) => [h.id, h]))
      const ids = [...this.queue].slice(0, BATCH)
      const rows = []
      const versions = new Map<string, string>()
      for (const id of ids) {
        const hand = byId.get(id)
        const json = hand ? JSON.stringify(hand) : null
        if (!hand || !json) {
          this.queue.delete(id) // gone since
          continue
        }
        if (bytes(json) > RECORD_MAX_BYTES) {
          // Never sendable: kept here, and said so (blocked), never
          // silently counted as saved.
          this.queue.delete(id)
          this.blocked.set(id, json)
          continue
        }
        versions.set(id, json)
        rows.push({
          user_id: this.userId,
          id,
          played_at: new Date(hand.at ?? Date.now()).toISOString(),
          record: hand,
        })
      }
      if (rows.length) {
        const { error } = await this.client
          .from('practice_hands')
          .upsert(rows, { onConflict: 'user_id,id' })
        if (error) {
          // The daily cap (54000): stop sending new hands until next time.
          if (error.code === '54000') this.capped = true
          else throw error
        } else
          for (const row of rows) {
            // The account has the version this request carried. A newer
            // one noted while it was on its way (the graded record after a
            // provisional one) stays queued and goes next (audit F08).
            const sentJson = versions.get(row.id)!
            this.sent.set(row.id, sentJson)
            this.blocked.delete(row.id)
            const now = this.latest?.hands.find((h) => h.id === row.id)
            if (!now || JSON.stringify(now) === sentJson)
              this.queue.delete(row.id)
          }
      }
      if (this.queue.size && !this.capped) return this.sendOnce()
    }
    if (this.trainerChanged()) {
      const doc = trainerDoc(progress)
      const at = Date.now()
      const { error } = await this.client.from('learning_state').upsert(
        {
          user_id: this.userId,
          trainer: doc,
          trainer_updated_at: new Date(at).toISOString(),
        },
        { onConflict: 'user_id' },
      )
      if (error) throw error
      this.sentTrainer = JSON.stringify(doc)
      write(
        TRAINER_SYNCED_KEY,
        JSON.stringify({ user: this.userId, doc: this.sentTrainer, at }),
      )
    }
  }

  // ---- The curriculum --------------------------------------------------------

  private startLearning(account: AccountState) {
    const owner = localStorage.getItem(LEARNING_OWNER_KEY)
    const local = localStorage.getItem(LEARNING_KEY)
    const choice = pickLearning(local, account, this.userId, owner)
    if (choice.kind === 'take') {
      if (choice.backup) write(LEARNING_BACKUP_KEY, choice.backup)
      write(LEARNING_KEY, choice.raw)
      if (!choice.raw) write(LEARNING_V1_KEY, null)
      this.hooks.reloadLearning()
    }
    write(LEARNING_OWNER_KEY, this.userId)
    if (choice.kind === 'send') {
      this.learningDirty = true
      void this.sendLearning().catch(() => this.learningLater())
    }
  }

  private learningSaved = () => {
    if (!this.ready || this.stopped) return
    this.learningDirty = true
    this.learningLater(LEARNING_DEBOUNCE_MS)
  }

  private learningLater(delay = this.wait) {
    if (this.stopped) return
    if (this.learningTimer) clearTimeout(this.learningTimer)
    this.learningTimer = setTimeout(() => {
      this.learningTimer = null
      void this.sendLearning().catch(() => {
        this.wait = Math.min(this.wait * 2, RETRY_MAX_MS)
        this.learningLater()
      })
    }, delay)
  }

  private async sendLearning() {
    const raw = localStorage.getItem(LEARNING_KEY)
    if (!raw) {
      this.learningDirty = false
      return
    }
    // Over the account's size: it cannot go, and that is not "saved".
    this.learningBlocked = bytes(raw) > CURRICULUM_MAX_BYTES
    if (this.learningBlocked) {
      this.learningDirty = false
      return
    }
    const at = curriculumTime(raw) ?? Date.now()
    const { error } = await this.client.from('learning_state').upsert(
      {
        user_id: this.userId,
        curriculum: raw,
        curriculum_updated_at: new Date(at).toISOString(),
      },
      { onConflict: 'user_id' },
    )
    if (error) throw error
    if (localStorage.getItem(LEARNING_KEY) === raw) this.learningDirty = false
  }
}

/**
 * Forgets this browser's practice data at sign-out (the account keeps it):
 * the progress, the curriculum, their markers and a waiting score.
 */
export function clearLocalPractice() {
  for (const key of [
    STORAGE_KEY,
    LEGACY_KEY,
    LEARNING_KEY,
    LEARNING_V1_KEY,
    LEARNING_BACKUP_KEY,
    LEARNING_OWNER_KEY,
    TRAINER_SYNCED_KEY,
    'qp.pendingClaim',
  ])
    write(key, null)
}
