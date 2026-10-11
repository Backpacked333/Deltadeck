// The six-seat smoke (P2-11), `scripts/smoke-ws.mjs --six`. Six clients
// reach a real six table, the first through the lobby's quick-sit and the
// rest by the table's id (as a link does; quick-sit's choice depends on
// whatever other tables a local server still lists), and play random legal
// moves hand after hand. Meanwhile the run makes one player leave, a new
// one join, one time out until the table sits them out (then sit in again)
// and one drop their connection and come back within the grace. Every
// frame is checked: no other seat's cards before they are shown, nothing
// of a hand for a socket without a seat, chips conserved within each hand,
// sequence numbers never going back, and every hand's reveal verifying
// against the commitment sent before its deal. Exits 1 above the P2-11
// p95 (150 ms) or on any broken invariant.
import { fromBase64, verifyDeal } from '../../src/engine/deck'
import type {
  HandRecordV1,
  LobbyMsg,
  MatchInfo,
  SeatView,
  ServerMsg,
} from '../../src/shared/protocol'
import { PROTOCOL } from '../../src/shared/protocol'
import { percentile, SIX_ACK_P95_LIMIT_MS, verdict } from '../smoke-stats'
import type { SmokeResult } from '../smoke-stats'

/** When, in hands finished, each scripted event starts. */
export const SIX_EVENTS = {
  leave: 15,
  join: 25,
  timeouts: 40,
  reconnect: 70,
} as const

/** How long a dropped player stays away: well inside the 60 s grace. */
const AWAY_MS = 3000
/** The whole run gives up after this long. */
const RUN_MS = 40 * 60_000

type Client = {
  name: string
  token: string
  ws: WebSocket | null
  /** Our seat at the table, from the last welcome. */
  seat: number | null
  /** Wants a seat: sends a bare sit on a seatless welcome. */
  sitting: boolean
  seq: number
  pending: { reqId: string; sentAt: number } | null
  /** Makes no move: its turns run out (the timeouts event). */
  silent: boolean
  /** Hands this client asked a rebuy for (one each). */
  rebuys: Set<string>
}

/** What the run saw of one hand. */
type HandLog = {
  /** Chips in the hand: stacks plus the pot, from its first view. */
  chips?: number
  commitment?: string
  record?: HandRecordV1
  revealed?: boolean
}

export async function six(target: string, secret: string, hands: number) {
  const run = new SixRun(target, secret, hands)
  return run.main()
}

class SixRun {
  readonly result: SmokeResult
  private readonly clients: Client[] = []
  private readonly handLogs = new Map<string, HandLog>()
  /** Hands counted: a reconnect sends the last one's end again. */
  private readonly counted = new Set<string>()
  private readonly events: string[] = []
  private readonly started = Date.now()
  private tableId = ''
  private n = 0
  private finish: (() => void) | null = null
  private table: MatchInfo | null = null
  /** The scripted events' watchers, cleared when the run ends. */
  private readonly watchers: ReturnType<typeof setInterval>[] = []

  constructor(
    private readonly target: string,
    private readonly secret: string,
    hands: number,
  ) {
    this.result = {
      hands: 0,
      target: hands,
      acks: [],
      failures: [],
      leaks: 0,
      commitments: 0,
    }
  }

  fail(what: string) {
    if (this.result.failures.length < 50) console.error(`FAIL ${what}`)
    this.result.failures.push(what)
  }

  private ws(path: string, token: string) {
    return new WebSocket(
      `${this.target.replace(/^http/, 'ws')}${path}`,
      // Node's WebSocket sends an Origin only when asked; the server
      // requires the site's own.
      {
        protocols: [PROTOCOL, `bearer.${token}`],
        headers: { Origin: this.target },
      } as unknown as string[],
    )
  }

  private client(i: number): Client {
    const name = `six${this.started.toString(36)}${i}`
    return {
      name,
      token: `dev.${name}.${this.secret}`,
      ws: null,
      seat: null,
      sitting: true,
      seq: 0,
      pending: null,
      silent: false,
      rebuys: new Set(),
    }
  }

  /** Asks the lobby for a six table to sit at; resolves with its id. */
  private quickSit(token: string) {
    return new Promise<string>((resolve, reject) => {
      const ws = this.ws('/ws/lobby', token)
      const timer = setTimeout(() => {
        ws.close(1000)
        reject(new Error('quick-sit: no answer in 15 s'))
      }, 15_000)
      ws.onopen = () => ws.send(JSON.stringify({ t: 'quick_sit' }))
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as LobbyMsg
        if (msg.t === 'sit_at' || msg.t === 'matched' || msg.t === 'error') {
          clearTimeout(timer)
          ws.close(1000)
          if (msg.t === 'sit_at') resolve(msg.tableId)
          else reject(new Error(`quick-sit answered ${JSON.stringify(msg)}`))
        }
      }
    })
  }

  /** The lobby's list, asked of a fresh lobby socket. */
  private listed(token: string) {
    return new Promise<{ tableId: string; seated: number }[]>((resolve) => {
      const ws = this.ws('/ws/lobby', token)
      const timer = setTimeout(() => {
        ws.close(1000)
        resolve([])
      }, 15_000)
      ws.onopen = () => ws.send(JSON.stringify({ t: 'tables' }))
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as LobbyMsg
        if (msg.t !== 'tables') return
        clearTimeout(timer)
        ws.close(1000)
        resolve(msg.tables)
      }
    })
  }

  private handOf(matchId: string, handNo: number) {
    const key = `${matchId}#${handNo}`
    if (!this.handLogs.has(key)) this.handLogs.set(key, {})
    return { key, log: this.handLogs.get(key)! }
  }

  /** Opens `me`'s table socket (again, after a drop). */
  private connect(me: Client) {
    const ws = this.ws(`/ws/table/${this.tableId}`, me.token)
    me.ws = ws
    me.pending = null
    ws.onclose = (e) => {
      if (me.ws !== ws) return
      me.ws = null
      if (e.code !== 1000) this.fail(`${me.name}: closed ${e.code} ${e.reason}`)
    }
    ws.onmessage = (event) =>
      void this.receive(me, JSON.parse(String(event.data)) as ServerMsg)
  }

  private async receive(me: Client, msg: ServerMsg) {
    if (msg.seq < me.seq)
      this.fail(`${me.name}: seq went back ${me.seq} → ${msg.seq}`)
    me.seq = Math.max(me.seq, msg.seq)
    switch (msg.t) {
      case 'error':
        return this.fail(`${me.name}: error ${msg.code} ${msg.message}`)
      case 'welcome':
      case 'state': {
        this.table = msg.table
        if (msg.t === 'welcome') me.seat = msg.seat
        if (me.seat === null) {
          // A socket without a seat sees the roster, never a hand.
          if (msg.view) {
            this.result.leaks++
            this.fail(`${me.name}: a view without a seat`)
          }
          if (msg.t === 'welcome' && me.sitting && me.ws)
            me.ws.send(JSON.stringify({ t: 'sit' }))
          return
        }
        if (msg.view) this.view(me, msg.view)
        this.maybeRebuy(me, msg.table, msg.view)
        return
      }
      case 'hand_start': {
        const { log } = this.handOf(msg.matchId, msg.handNo)
        if (log.commitment && log.commitment !== msg.commitment)
          this.fail(`${msg.matchId}#${msg.handNo}: two commitments`)
        log.commitment ??= msg.commitment
        return
      }
      case 'hand_end': {
        if (this.counted.has(`${msg.matchId}#${msg.handNo}`)) return
        const { log } = this.handOf(msg.matchId, msg.handNo)
        if (log.record) return
        log.record = msg.record
        const net = Object.values(msg.record.netBySeat).reduce(
          (s, x) => s + x,
          0,
        )
        if (net !== 0) this.fail(`${msg.matchId}#${msg.handNo}: net ${net}`)
        const dealt = msg.record.config.seats.reduce((s, p) => s + p.stack, 0)
        if (log.chips !== undefined && dealt !== log.chips)
          this.fail(
            `${msg.matchId}#${msg.handNo}: dealt ${dealt} ≠ ${log.chips}`,
          )
        if (log.commitment && msg.record.commitment !== log.commitment)
          this.fail(`${msg.matchId}#${msg.handNo}: record commitment differs`)
        return this.handDone(msg.matchId, msg.handNo)
      }
      case 'reveal': {
        if (this.counted.has(`${msg.matchId}#${msg.handNo}`)) return
        const { log } = this.handOf(msg.matchId, msg.handNo)
        if (log.revealed) return
        if (!log.record || !log.commitment)
          return this.fail(
            `${msg.matchId}#${msg.handNo}: reveal before record or commitment`,
          )
        log.revealed = true
        const ok = await verifyDeal(
          log.commitment,
          fromBase64(msg.leaves),
          msg.slots,
          log.record,
        )
        if (ok) this.result.commitments++
        else this.fail(`${msg.matchId}#${msg.handNo}: reveal does not verify`)
        return this.handDone(msg.matchId, msg.handNo)
      }
    }
  }

  /** Checks one seat's view, records an ack, and moves on our turn. */
  private view(me: Client, view: SeatView) {
    for (const p of view.players)
      if (p.seat !== view.you && p.cards && !p.shown) {
        this.result.leaks++
        this.fail(
          `${me.name} ${view.matchId}#${view.handNo}: seat ${p.seat}'s cards before shown`,
        )
      }
    // A view of a hand: stacks and pot together are the chips dealt, the
    // same in every view of it (the result's stacks hold the pot).
    if (view.you !== null) {
      const { log } = this.handOf(view.matchId, view.handNo)
      const stacks = view.players.reduce((s, p) => s + p.stack, 0)
      const total = view.result ? stacks : stacks + view.pot.total
      log.chips ??= total
      if (total !== log.chips)
        this.fail(
          `${me.name} ${view.matchId}#${view.handNo}: chips ${total} ≠ ${log.chips}`,
        )
    }
    if (me.pending && view.lastReqId === me.pending.reqId) {
      this.result.acks.push(Date.now() - me.pending.sentAt)
      me.pending = null
    }
    if (
      me.pending ||
      me.silent ||
      // Stood up: the table folds for us when the action comes round.
      !me.sitting ||
      !me.ws ||
      view.result ||
      view.toAct === null ||
      view.toAct !== view.you ||
      !view.legal
    )
      return
    const legal = view.legal
    const roll = Math.random()
    const action =
      roll < 0.1
        ? { type: 'fold' as const }
        : roll < 0.25 && legal.canRaise
          ? { type: 'raise' as const, to: legal.minRaiseTo }
          : legal.canCheck
            ? { type: 'check' as const }
            : { type: 'call' as const }
    const reqId = `x${++this.n}`
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

  /** A seat with no chips, out of any hand being played, tops up. */
  private maybeRebuy(me: Client, table: MatchInfo, view: SeatView | null) {
    const mine = table.players.find((p) => p.seat === me.seat)
    if (!mine || mine.stack !== 0 || (view && !view.result) || !me.ws) return
    const key = `${view?.matchId ?? ''}#${view?.handNo ?? 0}`
    if (me.rebuys.has(key)) return
    me.rebuys.add(key)
    me.ws.send(JSON.stringify({ t: 'rebuy' }))
  }

  private handDone(matchId: string, handNo: number) {
    const { key, log } = this.handOf(matchId, handNo)
    if (!log.record || !log.revealed) return
    this.handLogs.delete(key)
    this.counted.add(key)
    this.result.hands++
    void this.script(this.result.hands)
    if (this.result.hands >= this.result.target) this.finish?.()
  }

  private watch(check: () => void, ms: number) {
    const timer = setInterval(check, ms)
    this.watchers.push(timer)
    return timer
  }

  /** The scripted events, each once, as the run passes its hand count. */
  private async script(hands: number) {
    const [, , c2, c3, , c5] = this.clients
    if (hands === SIX_EVENTS.leave) {
      this.events.push(`leave: ${c5.name} stood up after hand ${hands}`)
      c5.sitting = false
      c5.ws?.send(JSON.stringify({ t: 'stand' }))
      // Gone once the seat is: the table frees it between hands at once,
      // or when the hand it is dealt into ends.
      const gone = this.watch(() => {
        if (c5.seat !== null) return
        clearInterval(gone)
        c5.ws?.close(1000, 'left')
        c5.ws = null
      }, 200)
    }
    if (hands === SIX_EVENTS.join) {
      const c6 = this.client(6)
      this.clients.push(c6)
      this.events.push(`join: ${c6.name} sat down after hand ${hands}`)
      this.connect(c6)
    }
    if (hands === SIX_EVENTS.timeouts) {
      this.events.push(
        `timeouts: ${c2.name} made no move from hand ${hands} until sat out`,
      )
      c2.silent = true
      const back = this.watch(() => {
        const mine = this.table?.players.find((p) => p.seat === c2.seat)
        if (mine?.status !== 'sitting_out') return
        clearInterval(back)
        this.events.push(`timeouts: ${c2.name} was sat out, and sat in again`)
        c2.silent = false
        c2.ws?.send(JSON.stringify({ t: 'sit_in' }))
      }, 500)
    }
    if (hands === SIX_EVENTS.reconnect) {
      this.events.push(
        `reconnect: ${c3.name} dropped after hand ${hands} and came back ${AWAY_MS / 1000} s later`,
      )
      const ws = c3.ws
      c3.ws = null
      ws?.close(1000, 'drop')
      setTimeout(() => this.connect(c3), AWAY_MS)
    }
  }

  async main() {
    console.log(
      `smoke --six: 6 clients at one six table, ${this.result.target} hands → ${this.target}`,
    )
    for (let i = 0; i < 6; i++) this.clients.push(this.client(i))
    this.tableId = await this.quickSit(this.clients[0].token)
    console.log(`quick-sit sent ${this.clients[0].name} to ${this.tableId}`)
    let limit: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<void>((resolve) => {
      this.finish = resolve
      limit = setTimeout(resolve, RUN_MS)
    })
    for (const c of this.clients) this.connect(c)
    await done
    // Or the process waits out the limit after printing its result.
    clearTimeout(limit)
    for (const timer of this.watchers) clearInterval(timer)
    const listed = await this.listed(this.clients[0].token)
    const entry = listed.find((t) => t.tableId === this.tableId)
    if (!entry) this.fail(`the lobby does not list ${this.tableId}`)
    for (const c of this.clients) {
      c.sitting = false
      c.ws?.send(JSON.stringify({ t: 'stand' }))
    }
    await new Promise((r) => setTimeout(r, 500))
    for (const c of this.clients) c.ws?.close(1000, 'smoke done')

    const r = this.result
    const ms = (p: number) => `${percentile(r.acks, p)} ms`
    console.log(
      `played ${r.hands} hands in ${((Date.now() - this.started) / 1000).toFixed(1)} s`,
    )
    for (const e of this.events) console.log(`event ${e}`)
    console.log(
      `ack latency over ${r.acks.length} moves: p50 ${ms(50)} · p95 ${ms(95)} · p99 ${ms(99)} (limit p95 ${SIX_ACK_P95_LIMIT_MS} ms)`,
    )
    console.log(
      `invariant failures ${r.failures.length} · leaks ${r.leaks} · commitments ${r.commitments}/${r.hands} · listed ${entry ? `${entry.seated} seated` : 'no'}`,
    )
    const problems = verdict(r, SIX_ACK_P95_LIMIT_MS)
    if (this.events.length < 5)
      problems.push(`${this.events.length} of 5 scripted events happened`)
    for (const p of problems) console.error(`FAIL ${p}`)
    console.log(problems.length ? 'FAIL' : 'PASS')
    return problems.length ? 1 : 0
  }
}
