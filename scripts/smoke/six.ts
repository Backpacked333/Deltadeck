// The six-seat smoke (P2-11), `scripts/smoke-ws.mjs --six`. Six clients
// reach a real six table, the first through the lobby's quick-sit and the
// rest by the table's id (as a link does), and play random legal moves
// hand after hand, watched by a seventh socket that never sits. Meanwhile
// the run makes one player stand up mid-hand, a new one join, one time out
// until the table sits them out (then sit in again) and one drop their
// connection and come back within the grace. It needs a server with no
// other player at a six table (fresh state): quick-sit sends the run to
// the fullest table with a free seat.
//
// What fails the run:
// - a leak: a view for another seat, another seat's cards before they are
//   shown (or shown folded, or before the showdown), a hand frame or a
//   view on a socket without a seat, or an own hole opening for a socket
//   not dealt in;
// - chips: a view of a hand whose stacks and pot differ from its first, a
//   record dealing other than that, an account dealt other than what its
//   last hand left it (or the 100 bb buy-in after a sit or a rebuy), or a
//   record naming another account at a client's seat;
// - frames: a sequence number going back, an error, a hand that started
//   and never ended (or a gap in hand numbers), a reveal that does not
//   verify, a dealt client's own opening missing or not verifying, a move
//   never acknowledged, a seat lost without a stand;
// - the events: each counted only once its effect shows (the stood player
//   kept the seat until the hand ended and was never dealt again; the
//   joiner and the reconnected player were dealt in after; the silent one
//   timed out twice, was sat out, missed a deal and sat in again);
// - the lobby not listing the table with the clients still seated;
// - a p95 client round trip over 150 ms (P2-11's number; this is a Node
//   client's send-to-ack on a local server, not ack-to-render, which
//   waits on the S7-05 telemetry).
import { fromBase64, verifyDeal, verifyOwn } from '../../src/engine/deck'
import { buyIn, SIX_BLINDS } from '../../src/engine/stacks'
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
/** A move still unacknowledged this long when the run ends is a failure. */
export const ACK_LOST_MS = 10_000
const BUY_IN = buyIn(SIX_BLINDS.bb)

export type Client = {
  name: string
  token: string
  ws: {
    send(data: string): void
    close(code?: number, reason?: string): void
  } | null
  /** Our seat at the table, from the last welcome. */
  seat: number | null
  /** Sends a bare sit on a seatless welcome: until first seated. */
  wantsSeat: boolean
  everSeated: boolean
  /** Sent a stand: the seatless welcome that follows is expected. */
  stood: boolean
  /** To stand once dealt into a hand it is not to act in (the leave). */
  standWanted: boolean
  /** The seat a reconnecting client must come back to. */
  returning: number | null
  seq: number
  pending: { reqId: string; sentAt: number } | null
  /** Makes no move: its turns run out (the timeouts event). */
  silent: boolean
  /** Sat or asked for a top-up since its last hand: 100 bb is allowed. */
  toppedUp: boolean
  rebuys: Set<string>
}

/** What the run saw of one hand. */
type HandLog = {
  /** Chips in the hand: stacks plus the pot, from its first view. */
  chips?: number
  commitment?: string
  record?: HandRecordV1
  revealed?: boolean
  /** Who each view said sat where, and the cards each saw of its own. */
  dealt: Map<number, string>
  cards: Map<string, [number, number]>
}

export async function six(target: string, secret: string, hands: number) {
  return new SixRun(target, secret, hands).main()
}

export class SixRun {
  readonly result: SmokeResult
  readonly clients: Client[] = []
  readonly events: string[] = []
  private readonly handLogs = new Map<string, HandLog>()
  /** Hands counted: a reconnect sends the last one's end again. */
  private readonly counted = new Set<string>()
  /** Every hand any socket saw start, by match id. */
  private readonly started = new Map<string, Set<number>>()
  /** Each account's stack as its last hand left it. */
  private readonly finals = new Map<string, number>()
  private readonly began = Date.now()
  tableId = ''
  private n = 0
  private finish: (() => void) | null = null
  private table: MatchInfo | null = null
  private foreign = false
  /** The leave: the hand the stood player stood in. */
  private stoodIn: { name: string; handNo: number; matchId: string } | null =
    null
  /** The timeouts: timeouts seen, sat out, then a deal without them. */
  private silence: {
    name: string
    timeouts: number
    out: boolean
    done: boolean
  } | null = null
  /** The joiner and the reconnected player, until dealt in after. */
  private readonly awaited = new Map<string, string>()

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

  private leak(what: string) {
    this.result.leaks++
    this.fail(what)
  }

  /** A client; an observer never sits. */
  client(i: number | string, observer = false): Client {
    const name = `six${this.began.toString(36)}${i}`
    return {
      name,
      token: `dev.${name}.${this.secret}`,
      ws: null,
      seat: null,
      wantsSeat: !observer,
      everSeated: false,
      stood: false,
      standWanted: false,
      returning: null,
      seq: 0,
      pending: null,
      silent: false,
      toppedUp: !observer,
      rebuys: new Set(),
    }
  }

  private send(me: Client, msg: object) {
    me.ws?.send(JSON.stringify(msg))
  }

  private socket(path: string, token: string) {
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

  /** Asks the lobby for a six table to sit at; resolves with its id. */
  private quickSit(token: string) {
    return new Promise<string>((resolve, reject) => {
      const ws = this.socket('/ws/lobby', token)
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
      const ws = this.socket('/ws/lobby', token)
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
    if (!this.handLogs.has(key))
      this.handLogs.set(key, { dealt: new Map(), cards: new Map() })
    return { key, log: this.handLogs.get(key)! }
  }

  private start(matchId: string, handNo: number) {
    if (!this.started.has(matchId)) this.started.set(matchId, new Set())
    this.started.get(matchId)!.add(handNo)
  }

  /** Opens `me`'s table socket (again, after a drop). */
  private connect(me: Client) {
    const ws = this.socket(`/ws/table/${this.tableId}`, me.token)
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

  async receive(me: Client, msg: ServerMsg) {
    if (msg.seq < me.seq)
      this.fail(`${me.name}: seq went back ${me.seq} → ${msg.seq}`)
    me.seq = Math.max(me.seq, msg.seq)
    switch (msg.t) {
      case 'error':
        return this.fail(`${me.name}: error ${msg.code} ${msg.message}`)
      case 'welcome':
      case 'state':
        return this.snapshot(me, msg)
      case 'hand_start': {
        if (me.seat === null)
          this.leak(
            `${me.name}: hand ${msg.handNo} started on a socket without a seat`,
          )
        this.start(msg.matchId, msg.handNo)
        const { log } = this.handOf(msg.matchId, msg.handNo)
        if (log.commitment && log.commitment !== msg.commitment)
          this.fail(`${msg.matchId}#${msg.handNo}: two commitments`)
        log.commitment ??= msg.commitment
        return
      }
      case 'hand_end':
        return this.handEnd(me, msg.matchId, msg.handNo, msg.record)
      case 'reveal':
        return this.reveal(me, msg)
    }
  }

  private snapshot(
    me: Client,
    msg: Extract<ServerMsg, { t: 'welcome' | 'state' }>,
  ) {
    this.table = msg.table
    const names = new Set(this.clients.map((c) => c.name))
    if (
      !this.foreign &&
      msg.table.players.some((p) => !names.has(p.username))
    ) {
      this.foreign = true
      this.fail(
        `${this.tableId} holds a player from outside this run: run --six against fresh state`,
      )
    }
    if (msg.t === 'welcome') {
      if (me.returning !== null && msg.seat !== me.returning)
        this.fail(
          `${me.name}: back from a drop at seat ${msg.seat}, not ${me.returning}`,
        )
      me.returning = null
      me.seat = msg.seat
      if (msg.seat !== null) {
        me.everSeated = true
        me.wantsSeat = false
      } else if (me.wantsSeat) this.send(me, { t: 'sit' })
      else if (me.everSeated && !me.stood)
        this.fail(`${me.name}: lost its seat`)
    }
    if (me.seat === null) {
      // A socket without a seat sees the roster, never a hand.
      if (msg.view) this.leak(`${me.name}: a view without a seat`)
      return
    }
    this.watchSilence()
    if (msg.view) this.view(me, msg.view)
    this.maybeRebuy(me, msg.table, msg.view)
  }

  /** Checks one seat's view, records an ack, and moves on our turn. */
  private view(me: Client, view: SeatView) {
    if (view.you !== null && view.you !== me.seat)
      this.leak(
        `${me.name} ${view.matchId}#${view.handNo}: a view for seat ${view.you}, sitting at ${me.seat}`,
      )
    for (const p of view.players) {
      if (p.seat !== view.you && p.cards && !p.shown)
        this.leak(
          `${me.name} ${view.matchId}#${view.handNo}: seat ${p.seat}'s cards before shown`,
        )
      if (p.shown && (p.folded || view.street !== 'showdown'))
        this.leak(
          `${me.name} ${view.matchId}#${view.handNo}: seat ${p.seat} shown ${p.folded ? 'folded' : `on the ${view.street}`}`,
        )
    }
    if (view.you !== null) {
      this.start(view.matchId, view.handNo)
      const { log } = this.handOf(view.matchId, view.handNo)
      log.dealt.set(view.you, me.name)
      const own = view.players.find((p) => p.seat === view.you)?.cards
      if (own) log.cards.set(me.name, own)
      // Stacks and pot together are the chips dealt, the same in every
      // view of the hand (the result's stacks hold the pot).
      const stacks = view.players.reduce((s, p) => s + p.stack, 0)
      const total = view.result ? stacks : stacks + view.pot.total
      log.chips ??= total
      if (total !== log.chips)
        this.fail(
          `${me.name} ${view.matchId}#${view.handNo}: chips ${total} ≠ ${log.chips}`,
        )
      // The leave: stand while dealt in and not to act, so the table keeps
      // the seat until the hand ends.
      if (
        me.standWanted &&
        !view.result &&
        view.toAct !== null &&
        view.toAct !== view.you
      ) {
        me.standWanted = false
        me.stood = true
        this.stoodIn = {
          name: me.name,
          handNo: view.handNo,
          matchId: view.matchId,
        }
        this.send(me, { t: 'stand' })
      }
    }
    if (me.pending && view.lastReqId === me.pending.reqId) {
      this.result.acks.push(Date.now() - me.pending.sentAt)
      me.pending = null
    }
    if (
      me.pending ||
      me.silent ||
      me.stood ||
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
    this.send(me, {
      t: 'act',
      reqId,
      handNo: view.handNo,
      actionIndex: view.actions.length,
      action,
    })
  }

  /** A seat with no chips, out of any hand being played, tops up. */
  private maybeRebuy(me: Client, table: MatchInfo, view: SeatView | null) {
    const mine = table.players.find((p) => p.seat === me.seat)
    if (!mine || mine.stack !== 0 || (view && !view.result) || !me.ws) return
    const key = `${view?.matchId ?? ''}#${view?.handNo ?? 0}`
    if (me.rebuys.has(key)) return
    me.rebuys.add(key)
    me.toppedUp = true
    this.send(me, { t: 'rebuy' })
  }

  /** The silent player, once the roster says the table sat them out. */
  private watchSilence() {
    const s = this.silence
    if (!s || s.out) return
    const mine = this.table?.players.find((p) => p.username === s.name)
    if (mine?.status !== 'sitting_out') return
    // Its timeouts are counted from the records, the last one's possibly
    // still to come: checked once a deal has left it out.
    s.out = true
    if (!mine.stack)
      this.fail(`${s.name}: sat out with no chips, not by its timeouts`)
  }

  private handEnd(
    me: Client,
    matchId: string,
    handNo: number,
    record: HandRecordV1,
  ) {
    const key = `${matchId}#${handNo}`
    if (this.counted.has(key)) return
    const { log } = this.handOf(matchId, handNo)
    if (me.seat === null && ![...log.dealt.values()].includes(me.name))
      this.leak(`${me.name}: hand ${handNo}'s end on a socket not dealt in`)
    if (log.record) return
    log.record = record
    this.start(matchId, handNo)
    const net = Object.values(record.netBySeat).reduce((s, x) => s + x, 0)
    if (net !== 0) this.fail(`${key}: net ${net}`)
    const dealt = record.config.seats.reduce((s, p) => s + p.stack, 0)
    if (log.chips !== undefined && dealt !== log.chips)
      this.fail(`${key}: dealt ${dealt} ≠ ${log.chips}`)
    if (log.commitment && record.commitment !== log.commitment)
      this.fail(`${key}: record commitment differs`)
    // Who the views said sat where is who the record says.
    for (const [seat, name] of log.dealt) {
      const named = record.seats.find((s) => s.seat === seat)?.username
      if (named !== name)
        this.fail(
          `${key}: seat ${seat} is ${name} in its views, ${named} in the record`,
        )
    }
    this.carry(key, record)
    this.scriptedOn(record)
    this.handDone(matchId, handNo)
  }

  /**
   * Chips from one hand to the next, per account: dealt what the last hand
   * left it, or the 100 bb buy-in after a sit or a rebuy from below it.
   */
  private carry(key: string, record: HandRecordV1) {
    for (const { seat, username } of record.seats) {
      const dealt = record.config.seats.find((s) => s.seat === seat)?.stack
      const last = this.finals.get(username)
      const c = this.clients.find((x) => x.name === username)
      const toppedUp =
        !!c?.toppedUp &&
        dealt === BUY_IN &&
        (last === undefined || last < BUY_IN)
      if (dealt !== last && !toppedUp)
        this.fail(
          `${key}: ${username} dealt ${dealt}, left with ${last ?? 'nothing'} by its last hand`,
        )
      // Used up only by the buy-in it allowed: a rebuy asked as a hand
      // ends goes out before that hand's record arrives.
      if (c && toppedUp) c.toppedUp = false
      this.finals.set(username, (dealt ?? 0) + (record.netBySeat[seat] ?? 0))
    }
  }

  /** Each scripted event, counted once its effect shows in a record. */
  private scriptedOn(record: HandRecordV1) {
    const names = new Set(record.seats.map((s) => s.username))
    const stood = this.stoodIn
    if (stood && record.matchId === stood.matchId) {
      if (record.handNo === stood.handNo && !names.has(stood.name))
        this.fail(`${stood.name}: gone from the hand it stood in`)
      if (record.handNo > stood.handNo && names.has(stood.name))
        this.fail(`${stood.name}: dealt in after standing up`)
      if (
        record.handNo > stood.handNo &&
        !this.events.some((e) => e.startsWith('leave'))
      )
        this.events.push(
          `leave: ${stood.name} stood up during hand ${stood.handNo}, kept the seat until it ended, and was not dealt again`,
        )
    }
    for (const [name, what] of this.awaited)
      if (names.has(name)) {
        this.awaited.delete(name)
        this.events.push(`${what}, and was dealt into hand ${record.handNo}`)
      }
    const s = this.silence
    if (s && !s.done) {
      const seat = record.seats.find((x) => x.username === s.name)?.seat
      if (seat !== undefined)
        s.timeouts += record.actions.filter(
          (a) => a.seat === seat && a.source === 'timeout',
        ).length
      if (s.out && seat === undefined) {
        s.done = true
        if (s.timeouts < 2)
          this.fail(`${s.name}: sat out after ${s.timeouts} timeouts, not 2`)
        const c = this.clients.find((x) => x.name === s.name)!
        c.silent = false
        this.send(c, { t: 'sit_in' })
        this.events.push(
          `timeouts: ${s.name} timed out ${s.timeouts} times, was sat out, missed hand ${record.handNo} and sat in again`,
        )
      }
    }
  }

  private async reveal(me: Client, msg: Extract<ServerMsg, { t: 'reveal' }>) {
    const key = `${msg.matchId}#${msg.handNo}`
    const { log } = this.handOf(msg.matchId, msg.handNo)
    const record = log.record
    if (!record || !log.commitment) {
      if (!this.counted.has(key))
        this.fail(`${key}: reveal before record or commitment`)
      return
    }
    // This socket's own opening: its own two cards, and only if dealt.
    const seat = record.seats.find((s) => s.username === me.name)?.seat
    if (seat === undefined) {
      if (msg.own) this.leak(`${me.name} ${key}: an own opening, not dealt in`)
    } else if (!msg.own) this.fail(`${me.name} ${key}: no own opening`)
    else {
      const cards = log.cards.get(me.name)
      const ok =
        !!cards &&
        (await verifyOwn(
          log.commitment,
          fromBase64(msg.leaves),
          msg.own,
          record.config,
          seat,
          cards,
        ))
      if (!ok) this.leak(`${me.name} ${key}: its own opening does not verify`)
    }
    if (log.revealed || this.counted.has(key)) return
    log.revealed = true
    const ok = await verifyDeal(
      log.commitment,
      fromBase64(msg.leaves),
      msg.slots,
      record,
    )
    if (ok) this.result.commitments++
    else this.fail(`${key}: reveal does not verify`)
    this.handDone(msg.matchId, msg.handNo)
  }

  private handDone(matchId: string, handNo: number) {
    const { key, log } = this.handOf(matchId, handNo)
    if (!log.record || !log.revealed || this.counted.has(key)) return
    this.counted.add(key)
    this.result.hands++
    this.script(this.result.hands)
    if (this.result.hands >= this.result.target) this.finish?.()
  }

  /** Starts each scripted event once, as the run passes its hand count. */
  private script(hands: number) {
    const [, , c2, c3, , c5] = this.clients
    if (!c5) return
    if (hands === SIX_EVENTS.leave) c5.standWanted = true
    if (hands === SIX_EVENTS.join) {
      const c6 = this.client(6)
      this.clients.push(c6)
      this.awaited.set(c6.name, `join: ${c6.name} sat down after hand ${hands}`)
      this.connect(c6)
    }
    if (hands === SIX_EVENTS.timeouts) {
      c2.silent = true
      this.silence = { name: c2.name, timeouts: 0, out: false, done: false }
    }
    if (hands === SIX_EVENTS.reconnect) {
      this.awaited.set(
        c3.name,
        `reconnect: ${c3.name} dropped after hand ${hands}, came back to seat ${c3.seat} ${AWAY_MS / 1000} s later`,
      )
      c3.returning = c3.seat
      const ws = c3.ws
      c3.ws = null
      ws?.close(1000, 'drop')
      setTimeout(() => this.connect(c3), AWAY_MS)
    }
  }

  /**
   * At the run's end: every hand started before the last one ended, with
   * no gap in the numbers, and no move left unacknowledged. Returns the
   * number of moves never acknowledged.
   */
  endChecks(now = Date.now()) {
    for (const [matchId, hands] of this.started) {
      const nos = [...hands].sort((a, b) => a - b)
      const last = nos[nos.length - 1]
      for (let h = nos[0]; h < last; h++)
        if (!this.counted.has(`${matchId}#${h}`))
          this.fail(
            `${matchId}#${h}: ${hands.has(h) ? 'started and never ended' : 'never seen'}`,
          )
    }
    const lost = this.clients.filter(
      (c) => c.pending && now - c.pending.sentAt > ACK_LOST_MS,
    )
    for (const c of lost) this.fail(`${c.name}: a move never acknowledged`)
    return lost.length
  }

  /**
   * Stands up the clients holding a seat: a stand from a socket without
   * one is refused (an error frame, so a failure).
   */
  standSeated() {
    for (const c of this.clients) {
      c.stood = true
      if (c.seat !== null) this.send(c, { t: 'stand' })
    }
  }

  /** The lobby's entry for the table, with the clients still seated. */
  listedCheck(entry: { seated: number } | undefined) {
    const seated = this.clients.filter((c) => c.seat !== null).length
    if (!entry) this.fail(`the lobby does not list ${this.tableId}`)
    else if (entry.seated !== seated)
      this.fail(`the lobby lists ${entry.seated} seated, not ${seated}`)
  }

  async main() {
    console.log(
      `smoke --six: 6 clients and a watcher at one six table, ${this.result.target} hands → ${this.target}`,
    )
    for (let i = 0; i < 6; i++) this.clients.push(this.client(i))
    this.clients.push(this.client('w', true))
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
    const unacked = this.endChecks()
    const listed = await this.listed(this.clients[0].token)
    const entry = listed.find((t) => t.tableId === this.tableId)
    this.listedCheck(entry)
    this.standSeated()
    await new Promise((r) => setTimeout(r, 500))
    for (const c of this.clients) c.ws?.close(1000, 'smoke done')

    const r = this.result
    const ms = (p: number) => `${percentile(r.acks, p)} ms`
    console.log(
      `played ${r.hands} hands in ${((Date.now() - this.began) / 1000).toFixed(1)} s`,
    )
    for (const e of this.events) console.log(`event ${e}`)
    console.log(
      `client round trip over ${r.acks.length} moves (${unacked} never acknowledged): p50 ${ms(50)} · p95 ${ms(95)} · p99 ${ms(99)} (limit p95 ${SIX_ACK_P95_LIMIT_MS} ms)`,
    )
    console.log(
      `invariant failures ${r.failures.length} · leaks ${r.leaks} · commitments ${r.commitments}/${r.hands} · listed ${entry ? `${entry.seated} seated` : 'no'}`,
    )
    const problems = verdict(r, SIX_ACK_P95_LIMIT_MS)
    if (this.events.length < 4)
      problems.push(`${this.events.length} of 4 scripted events happened`)
    for (const p of problems) console.error(`FAIL ${p}`)
    console.log(problems.length ? 'FAIL' : 'PASS')
    return problems.length ? 1 : 0
  }
}
