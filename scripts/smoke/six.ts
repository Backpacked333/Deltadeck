// The six-seat smoke (P2-11): six clients at one casual six table play
// random legal moves for `hands` hands while the run makes trouble on
// purpose: players stand up and sit down again, sockets drop and come back
// within the reconnect grace, and a player lets the clock run out. Every
// frame is checked as in the heads-up smoke: no other seat's card before it
// is shown, chips conserved, sequence numbers never going back, and every
// hand ending with its record and a reveal that verifies against the
// commitment sent before the deal.
//
// Seat 0's client never leaves: it counts the hands and checks the records.
// It opens the table with a quick-sit, as a player does; the others sit at
// that table from its link, as from the table list.
import { fromBase64, verifyDeal } from '../../src/engine/deck'
import type {
  HandRecordV1,
  LobbyMsg,
  SeatView,
  ServerMsg,
} from '../../src/shared/protocol'
import { PROTOCOL } from '../../src/shared/protocol'
import type { SmokeResult } from '../smoke-stats'

/** What the run does to the table, by the hand count seat 0 has seen. */
export type Chaos = {
  /** Every this many hands, one player stands and sits again 2 hands later. */
  leaveEvery: number
  /** Every this many hands, one player's socket drops and reconnects. */
  reconnectEvery: number
  /** How many decisions in the run are left to the clock. */
  timeouts: number
}

export const DEFAULT_CHAOS: Chaos = {
  leaveEvery: 15,
  reconnectEvery: 25,
  timeouts: 2,
}

type Player = {
  index: number
  token: string
  ws: WebSocket | null
  seq: number
  pending: { reqId: string; sentAt: number } | null
  /** Standing up: off the table until `back` hands have passed. */
  away: number | null
  /** Ignores its turns until the next hand: the clock decides for it. */
  idle: boolean
  /** Our own close, so the closed socket is not a failure. */
  leaving: boolean
  /** A rebuy sent this hand. */
  rebuying: boolean
  /** This connection has asked to sit. */
  asked: boolean
}

type HandLog = {
  commitment?: string
  chips?: number
  record?: HandRecordV1
  revealed?: boolean
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class SixRun {
  result: SmokeResult
  /** Chaos that happened, for the report. */
  events = { leaves: 0, reconnects: 0, timeouts: 0, rebuys: 0 }
  private n = 0
  private players: Player[]
  private hands = new Map<number, HandLog>()
  private tableId = ''
  private done!: () => void
  private finished = new Promise<void>((r) => (this.done = r))
  private ended = false
  private bb = 20

  constructor(
    readonly target: string,
    tokens: string[],
    hands: number,
    readonly chaos: Chaos = DEFAULT_CHAOS,
    readonly deadlineMs = 30 * 60_000,
  ) {
    this.result = {
      hands: 0,
      target: hands,
      acks: [],
      failures: [],
      leaks: 0,
      commitments: 0,
    }
    this.players = tokens.map((token, index) => ({
      index,
      token,
      ws: null,
      seq: 0,
      pending: null,
      away: null,
      idle: false,
      leaving: false,
      rebuying: false,
      asked: false,
    }))
  }

  fail(what: string) {
    if (this.result.failures.length < 50) console.error(`FAIL ${what}`)
    this.result.failures.push(what)
  }

  private socket(path: string, token: string) {
    return new WebSocket(
      `${this.target.replace(/^http/, 'ws')}${path}`,
      // Node's WebSocket sends an Origin only when asked; a browser always
      // does, and the server requires the site's own.
      {
        protocols: [PROTOCOL, `bearer.${token}`],
        headers: { Origin: this.target },
      } as unknown as string[],
    )
  }

  /** Seat 0's quick-sit: the lobby opens a table and says which. */
  private quickSit(token: string) {
    return new Promise<string>((resolve, reject) => {
      const ws = this.socket('/ws/lobby', token)
      ws.onopen = () => ws.send(JSON.stringify({ t: 'quick_sit' }))
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as LobbyMsg
        if (msg.t === 'sit_at') {
          ws.close(1000)
          resolve(msg.tableId)
        } else if (msg.t === 'matched') {
          ws.close(1000)
          resolve(msg.matchId)
        } else if (msg.t === 'error') {
          ws.close(1000)
          reject(new Error(`quick_sit: ${msg.code} ${msg.message}`))
        }
      }
      ws.onerror = () => reject(new Error('quick_sit: lobby socket failed'))
    })
  }

  async run() {
    this.tableId = await this.quickSit(this.players[0].token)
    for (const p of this.players) {
      this.connect(p, true)
      // Sit one at a time, so seats fill in order and the table starts.
      await wait(150)
    }
    const timer = setTimeout(() => {
      this.fail(`deadline: ${this.result.hands} hands in ${this.deadlineMs} ms`)
      this.end()
    }, this.deadlineMs)
    await this.finished
    clearTimeout(timer)
  }

  private end() {
    if (this.ended) return
    this.ended = true
    for (const p of this.players) {
      p.leaving = true
      p.ws?.close(1000, 'smoke done')
    }
    this.done()
  }

  private log(handNo: number) {
    if (!this.hands.has(handNo)) this.hands.set(handNo, {})
    return this.hands.get(handNo)!
  }

  private connect(p: Player, sit: boolean) {
    const ws = this.socket(`/ws/table/${this.tableId}`, p.token)
    p.ws = ws
    p.seq = 0
    p.leaving = false
    p.asked = false
    ws.onclose = (e) => {
      if (p.ws !== ws) return
      p.ws = null
      if (!p.leaving && !this.ended)
        this.fail(`player ${p.index}: closed ${e.code} ${e.reason}`)
    }
    ws.onmessage = (event) =>
      void this.message(p, JSON.parse(String(event.data)) as ServerMsg, sit)
  }

  private send(p: Player, msg: object) {
    if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg))
  }

  private async message(p: Player, msg: ServerMsg, sit: boolean) {
    if (msg.seq < p.seq)
      this.fail(`player ${p.index}: seq went back ${p.seq} → ${msg.seq}`)
    p.seq = Math.max(p.seq, msg.seq)
    switch (msg.t) {
      case 'error':
        // Expected answers to the run's own timing: a rebuy that lands
        // while its hand is still being settled, or one after another
        // already topped up; a sit too soon after standing (tried again
        // next hand). Anything else is a broken rule.
        if (msg.code === 'in_hand' || msg.code === 'not_below') return
        if (msg.code === 'sit_cooldown') {
          p.away = 1
          return
        }
        return this.fail(`player ${p.index}: error ${msg.code} ${msg.message}`)
      case 'welcome':
        // The server welcomes again once seated: sit on the first only.
        if (sit && !p.asked && p.away === null) {
          p.asked = true
          this.send(p, { t: 'sit' })
        }
        if (msg.view) this.view(p, msg.view)
        return
      case 'state':
        if (msg.view) this.view(p, msg.view)
        return
      case 'hand_start': {
        p.idle = false
        p.rebuying = false
        this.bb = msg.blinds.bb
        if (p.index !== 0) return
        const h = this.log(msg.handNo)
        // Stacks are sent after the blinds; a dead small blind posts none.
        h.chips =
          msg.stacks.reduce((s, x) => s + x, 0) +
          (msg.sb === null ? 0 : msg.blinds.sb) +
          msg.blinds.bb
        if (h.commitment && h.commitment !== msg.commitment)
          this.fail(`#${msg.handNo}: two commitments`)
        h.commitment ??= msg.commitment
        return
      }
      case 'hand_end': {
        if (p.index !== 0) return
        const h = this.log(msg.handNo)
        h.record = msg.record
        const net = Object.values(msg.record.netBySeat).reduce(
          (s, x) => s + x,
          0,
        )
        if (net !== 0) this.fail(`#${msg.handNo}: net ${net}`)
        const dealt = msg.record.config.seats.reduce((s, x) => s + x.stack, 0)
        if (h.chips !== undefined && dealt !== h.chips)
          this.fail(`#${msg.handNo}: dealt ${dealt} ≠ ${h.chips}`)
        if (h.commitment && msg.record.commitment !== h.commitment)
          this.fail(`#${msg.handNo}: record commitment differs`)
        return this.handDone(msg.handNo)
      }
      case 'reveal': {
        if (p.index !== 0) return
        const h = this.log(msg.handNo)
        if (!h.record || !h.commitment)
          return this.fail(`#${msg.handNo}: reveal before record or commitment`)
        const ok = await verifyDeal(
          h.commitment,
          fromBase64(msg.leaves),
          msg.slots,
          h.record,
        )
        if (ok) this.result.commitments++
        else this.fail(`#${msg.handNo}: reveal does not verify`)
        h.revealed = true
        return this.handDone(msg.handNo)
      }
    }
  }

  private handDone(handNo: number) {
    const h = this.log(handNo)
    if (!h.record || !h.revealed) return
    this.hands.delete(handNo)
    const count = ++this.result.hands
    if (count >= this.result.target) return this.end()
    this.trouble(count)
  }

  /** Between hands, by seat 0's count: the planned chaos. */
  private trouble(count: number) {
    const others = this.players.slice(1)
    for (const p of others)
      if (p.away !== null && --p.away <= 0) {
        p.away = null
        this.send(p, { t: 'sit' })
      }
    const pick = () => {
      const here = others.filter((p) => p.away === null && p.ws)
      return here[count % here.length]
    }
    if (count % this.chaos.leaveEvery === 0) {
      const p = pick()
      if (p) {
        this.events.leaves++
        p.away = 2
        this.send(p, { t: 'stand' })
      }
    }
    if (count % this.chaos.reconnectEvery === 0) {
      const p = pick()
      if (p?.ws) {
        this.events.reconnects++
        p.leaving = true
        p.ws.close(1000, 'smoke reconnect')
        p.ws = null
        // Back well inside the 60 s grace: the seat is still theirs.
        setTimeout(() => !this.ended && this.connect(p, false), 2_000)
      }
    }
    const every = Math.floor(this.result.target / (this.chaos.timeouts + 1))
    if (
      this.events.timeouts < this.chaos.timeouts &&
      every > 0 &&
      count % every === 0
    ) {
      const p = pick()
      if (p) {
        this.events.timeouts++
        p.idle = true
      }
    }
  }

  /** Checks one seat's view, records an ack, and moves on our turn. */
  private view(p: Player, view: SeatView) {
    for (const other of view.players)
      if (other.seat !== view.you && other.cards && !other.shown) {
        this.result.leaks++
        this.fail(`#${view.handNo}: seat ${other.seat}'s cards before shown`)
      }
    const h = this.hands.get(view.handNo)
    if (h?.chips !== undefined) {
      const stacks = view.players.reduce((s, x) => s + x.stack, 0)
      const total = view.result ? stacks : stacks + view.pot.total
      if (total !== h.chips)
        this.fail(`#${view.handNo}: chips ${total} ≠ ${h.chips}`)
    }
    if (p.pending && view.lastReqId === p.pending.reqId) {
      this.result.acks.push(Date.now() - p.pending.sentAt)
      p.pending = null
    }
    const seat = view.match.players.find((x) => x.seat === view.you)
    // Short-stacked between hands: top up, as a player would.
    if (
      view.you !== null &&
      seat?.stack !== undefined &&
      seat.stack < 40 * this.bb &&
      !p.rebuying &&
      // Standing up: the seat may already be gone.
      p.away === null &&
      (view.result || view.street === 'showdown')
    ) {
      this.events.rebuys++
      p.rebuying = true
      this.send(p, { t: 'rebuy' })
    }
    if (
      p.idle ||
      p.pending ||
      view.result ||
      view.street === 'showdown' ||
      view.you === null ||
      view.toAct !== view.you ||
      !view.legal ||
      !p.ws
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
    p.pending = { reqId, sentAt: Date.now() }
    this.send(p, {
      t: 'act',
      reqId,
      handNo: view.handNo,
      actionIndex: view.actions.length,
      action,
    })
  }
}
