import { describe, expect, it, vi } from 'vitest'
import { equity } from '../../src/engine/luck'
import { ids } from '../../src/engine/testing'
import { inspectSettlement } from '../src/settlement-evidence'
import { classifySettlement, catchUpSettlements } from '../src/settlement'
import { problemsWith } from '../src/verify'
import { handFixture, settlementFixture } from './settlement-fixtures'
import { env } from 'cloudflare:test'
import { applyRating } from '../src/rating'

describe('F07 rated evidence', () => {
  it('finalization pause retries without certificate or rating mutations', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    try {
      expect(
        await applyRating(
          { ...env, TRUST_PAUSE_RATING_FINALIZATION: 'true' },
          { matchId: 'paused', players: [] },
          Date.now(),
        ),
      ).toEqual({ ok: false, status: 503 })
      expect(network).not.toHaveBeenCalled()
    } finally {
      network.mockRestore()
    }
  })
  it('replays exact archived all-in equity; alteration, missing adjustment and non-finite values cannot verify', async () => {
    const h = await handFixture(undefined, 1, 'flop')
    expect(await problemsWith(h)).toEqual([])
    h.record.luck!.adjustedBySeat[0]++
    expect(await problemsWith(h)).toContain('luck')
    h.record.luck!.adjustedBySeat[0] = Infinity
    expect(await problemsWith(h)).toContain('non_finite_record')
    const missing = await handFixture()
    delete missing.record.luck
    expect(await problemsWith(missing)).toContain('luck')
  })
  it('rejects noncanonical or duplicate seat domains and a source substitution', async () => {
    const h = await handFixture()
    h.holes['00'] = h.holes['0']
    expect(await problemsWith(h)).toContain('seat_domain')
    delete h.holes['00']
    h.archive = { ...h.archive, deck: [1, 2] }
    expect(await problemsWith(h)).toContain('archive_source')
  })
  it('golden turn oracle, symmetry, conservation, and preflop Worker benchmark', async () => {
    const a = ids('Ah Ad'),
      b = ids('Ks Kc'),
      board = ids('Kd 7c 2h 9s')
    expect(equity(a, b, board)).toBe(2 / 44)
    expect(equity(a, b, board) + equity(b, a, board)).toBe(1)
    const hand = await handFixture(undefined, 1, 'preflop')
    const before = performance.now()
    expect(await problemsWith(hand)).toEqual([])
    console.info(
      `F07 local workerd preflop verifier wall-ms=${performance.now() - before}; not deployed CPU quota evidence`,
    )
    expect(hand.record.luck!.equity![0]).toBeGreaterThan(0.81)
    expect(hand.record.luck!.equity![0]).toBeLessThan(0.83)
    expect(
      hand.record.luck!.adjustedBySeat[0] + hand.record.luck!.adjustedBySeat[1],
    ).toBeCloseTo(0, 9)
  })
  it.each(['complete', 'forfeit', 'no_show', 'abandoned'] as const)(
    'certifies valid %s as the distinct terminal class',
    async (reason) => {
      const verdict = await inspectSettlement(
        await settlementFixture(undefined, reason),
      )
      expect(verdict).toMatchObject({
        state: 'verified',
        certificate: {
          reason,
          disposition: ['complete', 'forfeit'].includes(reason)
            ? 'rated'
            : 'void',
        },
      })
    },
  )
  it('quarantines zero-hand complete, wrong participant, duplicate/gapped manifest, altered outcome and invalid timeout', async () => {
    const valid = await settlementFixture()
    for (const change of [
      (s: typeof valid) => {
        s.hands = []
        s.terminal!.proof.completedHands = []
      },
      (s: typeof valid) => {
        s.players[0].userId = 'foreign'
      },
      (s: typeof valid) => {
        s.terminal!.proof.completedHands[1] =
          s.terminal!.proof.completedHands[0]
      },
      (s: typeof valid) => {
        s.terminal!.proof.completedHands[0].handNo = 2
      },
      (s: typeof valid) => {
        s.result.outcomeBySeat![0] = 'win'
      },
      (s: typeof valid) => {
        s.terminal!.proof.cause = 'timeout_streak'
      },
    ]) {
      const s = structuredClone(valid)
      change(s)
      expect((await inspectSettlement(s)).state).toBe('quarantined')
    }
    const invalid = await settlementFixture(undefined, 'forfeit')
    invalid.terminal!.proof.timeoutEvidence[0].processedAt = 0
    expect((await inspectSettlement(invalid)).state).toBe('quarantined')
  })
  it('missing archives/verifications remain pending and legacy proof absence never certifies', async () => {
    const s = await settlementFixture()
    s.hands.pop()
    expect((await inspectSettlement(s)).state).toBe('waiting-for-evidence')
    s.terminal = null
    expect((await inspectSettlement(s)).state).toBe('legacy-insufficient')
  })
  it('quarantines failed hand evidence during catch-up without attempting a rating', async () => {
    const s = await settlementFixture(undefined, 'forfeit')
    const h = s.hands[0]
    h.verification = null
    h.verified = false
    h.record.luck!.adjustedBySeat[0]++
    const writes: { fn: string; p: Record<string, unknown> }[] = []
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const fn = String(input).split('/').at(-1)!
        const p = JSON.parse(String(init?.body)).p
        writes.push({ fn, p })
        if (fn === 'settlement_candidates')
          return Response.json([{ matchId: s.matchId, hands: [1] }])
        if (fn === 'audit_hand') return Response.json(h)
        if (fn === 'audit_settlement') return Response.json(s)
        return new Response(null, { status: 204 })
      },
    )
    try {
      await catchUpSettlements(env, s.terminal!.proof.finishedAt)
      expect(
        writes.find((x) => x.fn === 'record_settlement_verdict')?.p,
      ).toMatchObject({
        matchId: s.matchId,
        state: 'quarantined',
        reasons: ['hand_verification_failed'],
      })
      expect(writes.some((x) => x.fn === 'apply_rating')).toBe(false)
      expect(writes.find((x) => x.fn === 'settlement_candidates')?.p).toEqual({
        limit: 4,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('shadow defaults read-only; bounded catchup uses durable lease scan', async () => {
    const s = await settlementFixture(undefined, 'no_show')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = String(input)
      calls.push(path)
      return Response.json(path.endsWith('audit_settlement') ? s : [])
    })
    try {
      expect((await classifySettlement(env, s.matchId)).state).toBe('verified')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('audit_settlement')
      await catchUpSettlements(env, 0)
      expect(calls.at(-1)).toContain('settlement_candidates')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
