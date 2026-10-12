import { env, SELF } from 'cloudflare:test'
import type { HandState, PlayerAction, SeatId } from '../../src/engine/types'
import type {
  ClientMsg,
  LobbyMsg,
  ServerMsg,
  SeatCommandV1,
} from '../../src/shared/protocol'
import type { LobbyDO } from '../src/lobby'
import type { InitBody, TableDO } from '../src/table'

export const ORIGIN = 'https://quantpoker.test'
/** The test Worker's DEV_AUTH_SECRET (worker/vitest.config.ts). */
export const DEV_SECRET = 'worker-test-secret-0001'
export const token = (user: string) => `dev.${user}.${DEV_SECRET}`

export function stub(matchId: string) {
  return env.TABLE.get(env.TABLE.idFromName(matchId))
}

/** A table created directly, so tests can choose a short match. */
export async function createTable(creator: string, handsTotal?: number) {
  const matchId = crypto.randomUUID()
  const body: InitBody = {
    matchId,
    creator: { userId: creator, username: creator },
    handsTotal,
  }
  const response = await stub(matchId).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (response.status !== 201) throw new Error(`init ${response.status}`)
  return matchId
}

export type Client = {
  ws: WebSocket
  frames: ServerMsg[]
  closed: { code: number; reason: string } | null
  send(msg: ClientMsg): void
  /** Resolves with the first frame (from `from` on) matching `test`. */
  next(test: (f: ServerMsg) => boolean, from?: number): Promise<ServerMsg>
}

export async function connect(matchId: string, user: string): Promise<Client> {
  const response = await SELF.fetch(`${ORIGIN}/ws/table/${matchId}`, {
    headers: {
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': `qp.v1, bearer.${token(user)}`,
    },
  })
  if (response.status !== 101)
    throw new Error(`upgrade ${response.status}: ${await response.text()}`)
  const ws = response.webSocket!
  let commands: Promise<void> = Promise.resolve()
  const client: Client = {
    ws,
    frames: [],
    closed: null,
    send: (msg) => {
      // Flow tests use the current client contract. Wire compatibility tests
      // send raw ws frames explicitly (including deliberately old controls).
      if (
        msg.t === 'stand' ||
        msg.t === 'rebuy' ||
        msg.t === 'sit_out' ||
        msg.t === 'sit_in'
      ) {
        commands = commands.then(async () => {
          await sendSeatCommand(client, matchId, msg.t, false)
        })
        return
      }
      ws.send(JSON.stringify(msg))
    },
    async next(test, from = 0) {
      for (let i = 0; i < 400; i++) {
        const found = client.frames.slice(from).find(test)
        if (found) return found
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`no matching frame among ${client.frames.length}`)
    },
  }
  ws.addEventListener('message', (e) => {
    client.frames.push(JSON.parse(e.data as string) as ServerMsg)
  })
  ws.addEventListener('close', (e) => {
    client.closed = { code: e.code, reason: e.reason }
  })
  ws.accept()
  return client
}

/** Authoritative resync first, then a new command (retries reuse the returned envelope). */
export async function sendSeatCommand(
  client: Client,
  tableId: string,
  kind: SeatCommandV1['kind'],
  resync = true,
) {
  const from = client.frames.length
  if (resync) client.ws.send(JSON.stringify({ t: 'resync' }))
  const frame = resync
    ? await client.next((f) => f.t === 'welcome', from)
    : [...client.frames]
        .reverse()
        .find((f) => f.t === 'state' || f.t === 'welcome')
  if (!frame || (frame.t !== 'welcome' && frame.t !== 'state'))
    throw new Error('Expected snapshot')
  const scope = frame.ownControl?.scope
  const command: SeatCommandV1 = {
    t: 'seat_command',
    v: 1,
    commandId: crypto.randomUUID(),
    tableId,
    kind,
    membershipGeneration: scope?.membershipGeneration ?? 1,
    seatGeneration: scope?.seatGeneration ?? 1,
    expectedStateVersion: frame.seq,
    hand: frame.view
      ? { tableId, matchId: frame.matchId, handNo: frame.view.handNo }
      : null,
  }
  client.ws.send(JSON.stringify(command))
  const outcome = await client.next(
    (f) => f.t === 'command_outcome' && f.commandId === command.commandId,
    from,
  )
  return { command, outcome }
}

/** The table's real state, for checking what clients were (not) told. */
export async function peek(matchId: string) {
  const { runInDurableObject } = await import('cloudflare:test')
  return runInDurableObject(stub(matchId), (instance: TableDO) => {
    const t = instance as unknown as {
      hand: HandState | null
      match: { status: string; handNo: number; net: Record<number, number> }
    }
    return { hand: t.hand, match: t.match }
  })
}

export const isState = (handNo: number, actions?: number) => (f: ServerMsg) =>
  (f.t === 'state' || f.t === 'welcome') &&
  f.view?.handNo === handNo &&
  (actions === undefined || f.view.actions.length === actions)

/** Every (viewer, other) pair of distinct seats, both ways round. */
export const seatPairs = (seats: SeatId[]) =>
  seats.flatMap((seat) =>
    seats
      .filter((other) => other !== seat)
      .map((other): [SeatId, SeatId] => [seat, other]),
  )

/**
 * The player in `seat`, found by its seat field: with empty seats a list's
 * position is not its seat number.
 */
export function bySeat<P extends { seat: SeatId }>(players: P[], seat: SeatId) {
  const found = players.find((p) => p.seat === seat)
  if (!found) throw new Error(`no player in seat ${seat}`)
  return found
}

/** The seat to act plays `choose(hand)`; resolves once the table applied it. */
export async function move(
  matchId: string,
  seats: Record<SeatId, Client>,
  choose: (hand: HandState) => PlayerAction,
) {
  const { hand } = await peek(matchId)
  const seat = hand!.toAct!
  const from = seats[seat].frames.length
  seats[seat].send({
    t: 'act',
    reqId: `m${hand!.config.handNo}-${hand!.actions.length}`,
    handNo: hand!.config.handNo,
    actionIndex: hand!.actions.length,
    action: choose(hand!),
  })
  await seats[seat].next(
    isState(hand!.config.handNo, hand!.actions.length + 1),
    from,
  )
}

/** Moves the table's clock `ms` forward, then fires its alarm. */
export async function elapse(matchId: string, ms: number) {
  const { runInDurableObject, runDurableObjectAlarm } = await import(
    'cloudflare:test'
  )
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    const base = instance.clock
    instance.clock = () => base() + ms
  })
  return runDurableObjectAlarm(stub(matchId))
}

/** Advance to the immutable completion schedule rather than assuming a flat pause. */
export async function elapseToNextDeal(matchId: string) {
  const { runInDurableObject } = await import('cloudflare:test')
  const ms = await runInDurableObject(
    stub(matchId),
    async (table: TableDO, state) => {
      const completion = await state.storage.get<{
        schedule: { earliestNextDealAt: number }
      }>('lastCompletion')
      return Math.max(
        0,
        (completion?.schedule.earliestNextDealAt ?? table.clock() + 3000) -
          table.clock(),
      )
    },
  )
  await elapse(matchId, ms)
  return ms
}

/** Stops the table's clock, so only `elapse` moves it. */
export async function freezeClock(matchId: string, at = 1_800_000_000_000) {
  const { runInDurableObject } = await import('cloudflare:test')
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    instance.clock = () => at
  })
}

export type LobbyClient = {
  ws: WebSocket
  frames: LobbyMsg[]
  closed: { code: number; reason: string } | null
  send(msg: ClientMsg): void
  next(test: (f: LobbyMsg) => boolean, from?: number): Promise<LobbyMsg>
}

/** A signed-in player's lobby socket. */
export async function lobby(user: string): Promise<LobbyClient> {
  const response = await SELF.fetch(`${ORIGIN}/ws/lobby`, {
    headers: {
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': `qp.v1, bearer.${token(user)}`,
    },
  })
  if (response.status !== 101)
    throw new Error(`upgrade ${response.status}: ${await response.text()}`)
  const ws = response.webSocket!
  const client: LobbyClient = {
    ws,
    frames: [],
    closed: null,
    send: (msg) => ws.send(JSON.stringify(msg)),
    async next(test, from = 0) {
      for (let i = 0; i < 400; i++) {
        const found = client.frames.slice(from).find(test)
        if (found) return found
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error(`no matching lobby frame among ${client.frames.length}`)
    },
  }
  ws.addEventListener('message', (e) =>
    client.frames.push(JSON.parse(e.data as string) as LobbyMsg),
  )
  ws.addEventListener('close', (e) => {
    client.closed = { code: e.code, reason: e.reason }
  })
  ws.accept()
  return client
}

/** Opens a table socket that the server may close straight away. */
export async function tryConnect(matchId: string, user: string) {
  const response = await SELF.fetch(`${ORIGIN}/ws/table/${matchId}`, {
    headers: {
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': `qp.v1, bearer.${token(user)}`,
    },
  })
  if (response.status !== 101) return { status: response.status, closed: null }
  const ws = response.webSocket!
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) =>
      resolve({ code: e.code, reason: e.reason }),
    ),
  )
  ws.accept()
  return { status: 101, closed }
}

/** Opens a lobby socket that the server may close straight away. */
export async function tryLobby(user: string) {
  const response = await SELF.fetch(`${ORIGIN}/ws/lobby`, {
    headers: {
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': `qp.v1, bearer.${token(user)}`,
    },
  })
  if (response.status !== 101) return { status: response.status, closed: null }
  const ws = response.webSocket!
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) =>
      resolve({ code: e.code, reason: e.reason }),
    ),
  )
  ws.accept()
  return { status: 101, ws, closed }
}

/** Sets the table's clock to `at` without firing its alarm. */
export async function setClock(matchId: string, at: number) {
  const { runInDurableObject } = await import('cloudflare:test')
  await runInDurableObject(stub(matchId), (instance: TableDO) => {
    instance.clock = () => at
  })
}

/** Every storage key a table holds, and its alarm. */
export async function storageOf(matchId: string) {
  const { runInDurableObject } = await import('cloudflare:test')
  return runInDurableObject(stub(matchId), async (_, state) => ({
    keys: [...(await state.storage.list()).keys()],
    alarm: await state.storage.getAlarm(),
  }))
}

/** Freezes the lobby's clock at `at`, or gives it back the real one (null). */
export async function setLobbyClock(at: number | null) {
  const { runInDurableObject } = await import('cloudflare:test')
  const { lobbyStub } = await import('../src/lobby')
  const { now } = await import('../src/clock')
  await runInDurableObject(lobbyStub(env), (lobby: LobbyDO) => {
    lobby.clock = at === null ? now : () => at
  })
}

/** POST /api/matches as `user`. */
export const createMatch = (user: string, headers: HeadersInit = {}) =>
  SELF.fetch(`${ORIGIN}/api/matches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(user)}`, ...headers },
  })

/** A six-casual table, made through the table's own /init, clock frozen. */
export async function sixTable() {
  const matchId = crypto.randomUUID()
  const body: InitBody = {
    matchId,
    creator: { userId: 'host', username: 'host' },
    kind: 'six-casual',
  }
  const response = await stub(matchId).fetch('https://table/init', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (response.status !== 201) throw new Error(`init ${response.status}`)
  await freezeClock(matchId)
  return matchId
}

/** `user` connects to a six table and sits (in `seat`, or the lowest free). */
export async function sitDown(matchId: string, user: string, seat?: SeatId) {
  const client = await connect(matchId, user)
  await client.next((f) => f.t === 'welcome')
  const from = client.frames.length
  client.send(seat === undefined ? { t: 'sit' } : { t: 'sit', seat })
  await client.next((f) => f.t === 'welcome' && f.seat !== null, from)
  return client
}

/** Plays the hand on the table to its end, each move chosen by `choose`. */
export async function playOut(
  matchId: string,
  seats: Record<SeatId, Client>,
  choose: (hand: HandState) => PlayerAction,
) {
  for (let guard = 0; guard < 200; guard++) {
    const { hand } = await peek(matchId)
    if (!hand || hand.street === 'showdown') return hand!
    await move(matchId, seats, choose)
  }
  throw new Error('the hand did not end')
}

/** Waits for `test` to hold (work a table does after its frames go out). */
export async function eventually(test: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await test()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('never happened')
}
