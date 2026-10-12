// The load and integrity smoke behind scripts/smoke-ws.mjs (which bundles
// this file, since the engine's imports need a bundler). Pairs of real
// WebSocket clients open invite tables through the public API and play
// random legal moves hand after hand, checking every frame they receive:
// no opponent card before it is shown, chips conserved, sequence numbers
// never going back, every hand ending with its record and a reveal that
// verifies against the commitment sent before the deal.
import { createInterface } from 'node:readline/promises'
import { readFileSync } from 'node:fs'
import { fromBase64, verifyDeal } from '../../src/engine/deck'
import type {
  HandRecordV1,
  SeatView,
  ServerMsg,
} from '../../src/shared/protocol'
import { PROTOCOL } from '../../src/shared/protocol'
import { ACK_P95_LIMIT_MS, percentile, verdict } from '../smoke-stats'
import { six } from './six'
import type { SmokeResult } from '../smoke-stats'

const PROD = 'https://deltadeck.net'
/** Typed by a person, at the keyboard, before any load reaches production. */
const PHRASE = 'I approve a load test against production'
const DEFAULT_SECRET = 'smoke-local-secret-0001'

type Options = {
  target: string
  pairs: number
  hands: number
  tokens: string[]
}

function parse(argv: string[]) {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    prod: argv.includes('--prod'),
    six: argv.includes('--six'),
    target: arg('target'),
    pairs: Number(arg('pairs') ?? 10),
    hands: Number(arg('hands') ?? 500),
    tokens: arg('tokens'),
    secret: arg('secret') ?? process.env.SMOKE_DEV_SECRET ?? DEFAULT_SECRET,
  }
}

/** Production needs a person to type the phrase, and real accounts. */
async function confirmProduction(tokensFile: string | undefined) {
  if (!process.stdin.isTTY)
    throw new Error(
      '--prod needs a person at a terminal to type the confirmation phrase; refusing.',
    )
  if (!tokensFile)
    throw new Error(
      '--prod needs --tokens <file>: one access token per line, two per table (dev tokens are off in production); refusing.',
    )
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const typed = await rl.question(
    `This plays real archived matches on ${PROD}.\nType exactly "${PHRASE}" to continue: `,
  )
  rl.close()
  if (typed.trim() !== PHRASE)
    throw new Error('Phrase did not match; refusing.')
  return readFileSync(tokensFile, 'utf8')
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
}

type Seat = {
  token: string
  ws: WebSocket
  seat: number | null
  pending: { reqId: string; sentAt: number } | null
  seq: number
  closed: boolean
  /** When each `ping` not yet answered went out, oldest first. */
  pings: number[]
}

/** Everything a pair saw of its current hand. */
type HandLog = {
  commitment?: string
  chips?: number
  record?: HandRecordV1
  revealed?: boolean
}

class Run {
  result: SmokeResult
  private n = 0
  private readonly started = Date.now()

  constructor(readonly options: Options) {
    this.result = {
      hands: 0,
      target: options.hands,
      acks: [],
      pings: [],
      failures: [],
      leaks: 0,
      commitments: 0,
    }
  }

  fail(what: string) {
    if (this.result.failures.length < 50) console.error(`FAIL ${what}`)
    this.result.failures.push(what)
  }

  async api(path: string, token: string) {
    const response = await fetch(`${this.options.target}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, string>,
    }
  }

  /** One pair plays matches until it has finished its share of hands. */
  async pair(index: number, a: string, b: string, quota: number) {
    let played = 0
    while (played < quota && Date.now() - this.started < 30 * 60_000) {
      const created = await this.api('/api/matches', a)
      if (created.status !== 201) {
        this.fail(
          `pair ${index}: POST /api/matches ${created.status} ${JSON.stringify(created.body)}`,
        )
        return
      }
      played += await this.match(
        index,
        created.body.matchId,
        [a, b],
        quota - played,
      )
    }
  }

  /** Plays one match (or `limit` hands of it); returns hands finished. */
  match(index: number, matchId: string, tokens: string[], limit: number) {
    return new Promise<number>((resolve) => {
      const hands = new Map<number, HandLog>()
      let finished = 0
      let done = false
      const seats: Seat[] = tokens.map((token) => {
        const ws = new WebSocket(
          `${this.options.target.replace(/^http/, 'ws')}/ws/table/${matchId}`,
          // Node's WebSocket sends an Origin only when asked; a browser
          // always does, and the server requires the site's own.
          {
            protocols: [PROTOCOL, `bearer.${token}`],
            headers: { Origin: this.options.target },
          } as unknown as string[],
        )
        return {
          token,
          ws,
          seat: null,
          pending: null,
          seq: 0,
          closed: false,
          pings: [],
        }
      })
      // The page's own link check (src/net/heartbeat.ts): a `ping` a second
      // per socket, whose round trip is the network leg of an ack, so the
      // time the table itself took is the ack less this.
      const pinger = setInterval(() => {
        for (const s of seats)
          if (s.ws.readyState === WebSocket.OPEN) {
            s.pings.push(Date.now())
            s.ws.send('ping')
          }
      }, 1000)
      const end = () => {
        if (done) return
        done = true
        clearInterval(pinger)
        for (const s of seats) s.ws.close(1000, 'smoke done')
        resolve(finished)
      }
      const log = (handNo: number) => {
        if (!hands.has(handNo)) hands.set(handNo, {})
        return hands.get(handNo)!
      }
      const handDone = (handNo: number) => {
        const h = log(handNo)
        if (!h.record || !h.revealed) return
        finished++
        this.result.hands++
        hands.delete(handNo)
        if (finished >= limit) end()
      }

      for (const me of seats) {
        me.ws.onclose = (e) => {
          me.closed = true
          if (!done && e.code !== 1000)
            this.fail(`pair ${index} ${matchId}: closed ${e.code} ${e.reason}`)
          if (!done) end()
        }
        me.ws.onmessage = async (event) => {
          if (event.data === 'pong') {
            const sentAt = me.pings.shift()
            if (sentAt !== undefined)
              this.result.pings?.push(Date.now() - sentAt)
            return
          }
          const msg = JSON.parse(String(event.data)) as ServerMsg
          if (msg.seq < me.seq)
            this.fail(`${matchId}: seq went back ${me.seq} → ${msg.seq}`)
          me.seq = Math.max(me.seq, msg.seq)
          switch (msg.t) {
            case 'error':
              return this.fail(`${matchId}: error ${msg.code} ${msg.message}`)
            case 'welcome':
              me.seat = msg.seat
              if (msg.view) this.view(me, msg.view, log(msg.view.handNo))
              return
            case 'state':
              if (msg.view) this.view(me, msg.view, log(msg.view.handNo))
              return
            case 'hand_start': {
              const h = log(msg.handNo)
              // Stacks are sent after the blinds are posted.
              h.chips =
                msg.stacks.reduce((s, x) => s + x, 0) +
                msg.blinds.sb +
                msg.blinds.bb
              if (h.commitment && h.commitment !== msg.commitment)
                this.fail(`${matchId}#${msg.handNo}: two commitments`)
              h.commitment ??= msg.commitment
              return
            }
            case 'hand_end': {
              if (me !== seats[0]) return
              const h = log(msg.handNo)
              h.record = msg.record
              const net = Object.values(msg.record.netBySeat).reduce(
                (s, x) => s + x,
                0,
              )
              if (net !== 0) this.fail(`${matchId}#${msg.handNo}: net ${net}`)
              const dealt = msg.record.config.seats.reduce(
                (s, p) => s + p.stack,
                0,
              )
              if (h.chips !== undefined && dealt !== h.chips)
                this.fail(
                  `${matchId}#${msg.handNo}: dealt ${dealt} ≠ ${h.chips}`,
                )
              if (h.commitment && msg.record.commitment !== h.commitment)
                this.fail(`${matchId}#${msg.handNo}: record commitment differs`)
              return handDone(msg.handNo)
            }
            case 'reveal': {
              if (me !== seats[0]) return
              const h = log(msg.handNo)
              // The record arrives just before its reveal on the same socket.
              const record = h.record
              if (!record || !h.commitment) {
                this.fail(
                  `${matchId}#${msg.handNo}: reveal before record or commitment`,
                )
                return
              }
              const ok = await verifyDeal(
                h.commitment,
                fromBase64(msg.leaves),
                msg.slots,
                record,
              )
              if (ok) this.result.commitments++
              else this.fail(`${matchId}#${msg.handNo}: reveal does not verify`)
              h.revealed = true
              return handDone(msg.handNo)
            }
            case 'match_end': {
              const net = Object.values(msg.result.netBySeat).reduce(
                (s, x) => s + x,
                0,
              )
              if (net !== 0) this.fail(`${matchId}: match net ${net}`)
              if (msg.result.reason !== 'complete')
                this.fail(`${matchId}: ended ${msg.result.reason}`)
              return end()
            }
          }
        }
      }
    })
  }

  /** Checks one seat's view, records an ack, and moves when it is our turn. */
  private view(me: Seat, view: SeatView, hand: HandLog) {
    const opponent = view.players.find((p) => p.seat !== view.you)
    if (opponent?.cards && !opponent.shown) {
      this.result.leaks++
      this.fail(`${view.matchId}#${view.handNo}: opponent cards before shown`)
    }
    if (hand.chips !== undefined) {
      const stacks = view.players.reduce((s, p) => s + p.stack, 0)
      const total = view.result ? stacks : stacks + view.pot.total
      if (total !== hand.chips)
        this.fail(
          `${view.matchId}#${view.handNo}: chips ${total} ≠ ${hand.chips}`,
        )
    }
    if (me.pending && view.lastReqId === me.pending.reqId) {
      this.result.acks.push(Date.now() - me.pending.sentAt)
      me.pending = null
    }
    if (
      me.pending ||
      view.result ||
      view.street === 'showdown' ||
      view.toAct !== view.you ||
      !view.legal ||
      me.closed
    )
      return
    const legal = view.legal
    const roll = Math.random()
    const action =
      roll < 0.05
        ? { type: 'fold' as const }
        : roll < 0.25 && legal.canRaise
          ? { type: 'raise' as const, to: legal.minRaiseTo }
          : legal.canCheck
            ? { type: 'check' as const }
            : { type: 'call' as const }
    const reqId = `s${++this.n}`
    me.pending = { reqId, sentAt: Date.now() }
    me.ws.send(
      JSON.stringify({
        t: 'act',
        reqId,
        handNo: view.handNo,
        actionIndex: view.actions.length,
        action,
      }),
    )
  }
}

/** --hands, for --six (its default is 200, not the pairs' 500). */
const arg6 = (argv: string[]) => {
  const i = argv.indexOf('--hands')
  return i >= 0 ? argv[i + 1] : undefined
}

export async function main(argv: string[]) {
  const args = parse(argv)
  const target = (
    args.prod ? PROD : (args.target ?? 'http://localhost:8787')
  ).replace(/\/$/, '')
  if (
    !args.prod &&
    /(^|\.)(deltadeck\.net|workers\.dev)$/.test(new URL(target).hostname)
  )
    throw new Error('Production is reached only with --prod; refusing.')
  // Six seats at one table (P2-11): local only, with dev tokens.
  if (args.six) {
    if (args.prod)
      throw new Error('--six runs against a local server only; refusing.')
    return six(target, args.secret, Number(arg6(argv) ?? 200))
  }
  const tokens = args.prod
    ? await confirmProduction(args.tokens)
    : Array.from(
        { length: args.pairs * 2 },
        (_, i) => `dev.smoke${Date.now().toString(36)}${i}.${args.secret}`,
      )
  const pairs = Math.floor(tokens.length / 2)
  const run = new Run({ target, pairs, hands: args.hands, tokens })
  console.log(
    `smoke: ${pairs * 2} clients, ${pairs} tables at a time, ${args.hands} hands → ${target}`,
  )
  const started = Date.now()
  const quota = (i: number) =>
    Math.floor(args.hands / pairs) + (i < args.hands % pairs ? 1 : 0)
  await Promise.all(
    Array.from({ length: pairs }, (_, i) =>
      run.pair(i, tokens[2 * i], tokens[2 * i + 1], quota(i)),
    ),
  )
  const r = run.result
  const ms = (p: number) => `${percentile(r.acks, p)} ms`
  console.log(
    `played ${r.hands} hands in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  )
  console.log(
    `ack latency over ${r.acks.length} moves: p50 ${ms(50)} · p95 ${ms(95)} · p99 ${ms(99)} (limit p95 ${ACK_P95_LIMIT_MS} ms)`,
  )
  if (r.pings?.length) {
    const link = (p: number) => `${percentile(r.pings!, p)} ms`
    console.log(
      `link round trip over ${r.pings.length} pings: p50 ${link(50)} · p95 ${link(95)} (an ack is this plus the table's own time)`,
    )
  }
  console.log(
    `invariant failures ${r.failures.length} · leaks ${r.leaks} · commitments ${r.commitments}/${r.hands}`,
  )
  const problems = verdict(r)
  for (const p of problems) console.error(`FAIL ${p}`)
  console.log(problems.length ? 'FAIL' : 'PASS')
  return problems.length ? 1 : 0
}
