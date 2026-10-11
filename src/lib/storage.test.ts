import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  emptyProgress,
  exportProgress,
  importProgress,
  sanitizeProgress,
  LEGACY_KEY,
  readProgress,
  saveProgress,
  STORAGE_KEY,
  upsertHand,
} from './storage'

afterEach(() => vi.unstubAllGlobals())
const storage = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
})

describe('local progress storage', () => {
  it.each([
    [0.62, 0.62],
    [0.05, DEFAULT_SETTINGS.split],
    ['wide', DEFAULT_SETTINGS.split],
  ])('keeps a sane table/lab split and defaults others (%s)', (split, kept) => {
    vi.stubGlobal(
      'localStorage',
      storage({ [STORAGE_KEY]: JSON.stringify({ settings: { split } }) }),
    )
    expect(readProgress().settings.split).toBe(kept)
  })
  it.each([
    [0.35, 0.35],
    [0, 0],
    [1.5, DEFAULT_SETTINGS.volume],
    ['loud', DEFAULT_SETTINGS.volume],
  ])(
    'keeps a valid volume and defaults an invalid one (%s)',
    (volume, kept) => {
      vi.stubGlobal(
        'localStorage',
        storage({ [STORAGE_KEY]: JSON.stringify({ settings: { volume } }) }),
      )
      expect(readProgress().settings.volume).toBe(kept)
    },
  )
  it.each(['not json', 'null', '5', '{}'])(
    'recovers safely from %s',
    (value) => {
      vi.stubGlobal('localStorage', storage({ [STORAGE_KEY]: value }))
      expect(readProgress()).toEqual(emptyProgress())
    },
  )
  it('filters invalid records, decisions and lessons', () => {
    vi.stubGlobal(
      'localStorage',
      storage({
        [STORAGE_KEY]: JSON.stringify({
          hands: [
            null,
            {},
            {
              id: '1',
              hand: 1,
              net: 20,
              result: 'Win',
              guided: false,
              decisions: [
                {
                  street: 'flop',
                  action: 'call',
                  grade: 'Best',
                  amount: 40,
                  pot: 160,
                  toCall: 40,
                  evLost: 0,
                  accuracy: 100,
                  chosenEV: 10,
                  bestEV: 10,
                  equity: 0.5,
                  bestLabel: 'Call 40',
                  handClass: 'Flush draw',
                  guess: 0.4,
                },
                { street: 'moon', action: 'call' },
              ],
            },
          ],
          lessons: ['options', 'options', 'not-a-lesson', 'ranges'],
          settings: { mode: 'analyst', theme: 'purple', sound: true },
        }),
      }),
    )
    const progress = readProgress()
    expect(progress.hands).toHaveLength(1)
    expect(progress.hands[0].decisions).toHaveLength(1)
    expect(progress.hands[0].decisions![0].guess).toBe(0.4)
    expect(progress.lessons).toEqual(['options', 'ranges'])
    expect(progress.settings).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'analyst',
      sound: true,
    })
  })
  it('migrates version 1 progress and skips onboarding for returning players', () => {
    vi.stubGlobal(
      'localStorage',
      storage({
        [LEGACY_KEY]: JSON.stringify({
          hands: [
            { id: 'a:1', hand: 1, net: -60, result: 'Fold', guided: true },
          ],
          lessons: ['equity'],
        }),
      }),
    )
    const progress = readProgress()
    expect(progress.hands).toHaveLength(1)
    expect(progress.lessons).toEqual(['equity'])
    expect(progress.onboarded).toBe(true)
    expect(progress.settings).toEqual(DEFAULT_SETTINGS)
  })
  it('handles blocked browser storage without breaking play', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Disabled')
      },
      setItem: () => {
        throw new Error('Disabled')
      },
    })
    expect(readProgress()).toEqual(emptyProgress())
    expect(saveProgress(emptyProgress())).toBe(false)
  })
  it('caps stored hand history at 100 records', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })
    const hands = Array.from({ length: 110 }, (_, i) => ({
      id: String(i),
      hand: i,
      net: 10,
      result: 'Win',
      guided: false,
    }))
    expect(saveProgress({ ...emptyProgress(), hands })).toBe(true)
    const saved = JSON.parse(setItem.mock.calls[0][1])
    expect(saved.version).toBe(2)
    expect(saved.hands).toHaveLength(100)
    expect(saved.hands[0].hand).toBe(10)
  })
  it('round-trips exports and rejects malformed imports', () => {
    const progress = {
      ...emptyProgress(),
      lessons: ['variance' as const],
      hands: [
        {
          id: 'x',
          hand: 3,
          net: 5,
          result: 'Win',
          guided: false,
          expectedNet: 2.5,
          hero: ['As', 'Kd'],
        },
      ],
    }
    expect(importProgress(exportProgress(progress))).toEqual(progress)
    expect(importProgress('nope')).toBeNull()
    expect(importProgress('{"lessons":[]}')).toBeNull()
  })
  it('upserts hands by id, replacing a provisional record in place', () => {
    const a = { id: 'a', hand: 1, net: 5, result: 'Win', guided: false }
    const b = {
      id: 'b',
      hand: 2,
      net: -60,
      result: 'Fold',
      guided: false,
      graded: false,
    }
    let progress = upsertHand(upsertHand(emptyProgress(), a), b)
    progress = upsertHand(progress, { ...b, graded: true, expectedNet: -40 })
    expect(progress.hands.map((h) => h.id)).toEqual(['a', 'b'])
    expect(progress.hands[1]).toMatchObject({ graded: true, expectedNet: -40 })
  })
})

describe('the account marker', () => {
  it('keeps whose progress this is and when it was cleared, if well formed', () => {
    const kept = sanitizeProgress({
      hands: [],
      owner: '11111111-1111-4111-8111-111111111111',
      historyClearedAt: 1760000000000,
    })
    expect(kept.owner).toBe('11111111-1111-4111-8111-111111111111')
    expect(kept.historyClearedAt).toBe(1760000000000)
    const dropped = sanitizeProgress({
      hands: [],
      owner: '<script>',
      historyClearedAt: 'yesterday',
    })
    expect(dropped.owner).toBeUndefined()
    expect(dropped.historyClearedAt).toBeUndefined()
  })

  it('never takes an owner from an imported file', () => {
    const file = JSON.stringify({
      hands: [],
      owner: 'someone',
      historyClearedAt: 5,
    })
    const imported = importProgress(file)!
    expect(imported.owner).toBeUndefined()
    expect(imported.historyClearedAt).toBeUndefined()
  })
})
