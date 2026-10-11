// Tests reuse the same player names, and an unfinished table from an earlier
// test would (correctly) keep them busy. Each test starts with an empty lobby
// on the real clock, with every account's frame and quick-sit budgets full
// (the quick-sit budgets are in the lobby's storage).
import { env, runInDurableObject } from 'cloudflare:test'
import { beforeEach } from 'vitest'
import { now } from '../src/clock'
import { lobbyStub } from '../src/lobby'
import type { LobbyDO } from '../src/lobby'
import type { FrameBudget } from '../src/limits'

beforeEach(async () => {
  await runInDurableObject(lobbyStub(env), async (lobby: LobbyDO) => {
    const inside = lobby as unknown as {
      ctx: DurableObjectState
      budget: FrameBudget
    }
    for (const ws of inside.ctx.getWebSockets()) ws.close(1000, 'test reset')
    await inside.ctx.storage.deleteAll()
    inside.budget.clear()
    lobby.clock = now
  })
})
