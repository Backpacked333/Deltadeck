// @vitest-environment node
// wrangler.jsonc carries numbers the Worker's code also relies on. They are
// checked here so the two cannot drift apart unnoticed.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { UPGRADES_PER_IP_PER_MINUTE } from '../worker/src/limits'
import { HANDS_DLQ, HANDS_QUEUE } from '../worker/src/queues'

type RateLimit = {
  name: string
  namespace_id: string
  simple: { limit: number; period: number }
}

type Queues = {
  producers: { binding: string; queue: string }[]
  consumers: {
    queue: string
    max_batch_size?: number
    max_retries?: number
    dead_letter_queue?: string
  }[]
}

const config = ts.parseConfigFileTextToJson(
  'wrangler.jsonc',
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
).config as { ratelimits: RateLimit[]; queues: Queues; triggers: { crons: string[] } }

describe('wrangler.jsonc', () => {
  it('F07 schedules bounded catch-up even when the queue wake-up is lost', () => {
    expect(config.triggers.crons).toEqual(['*/5 * * * *'])
  })
  it('limits each client address to UPGRADES_PER_IP_PER_MINUTE signed-in requests a minute', () => {
    const limiter = config.ratelimits.find((r) => r.name === 'IP_LIMITER')
    expect(limiter?.simple).toEqual({
      limit: UPGRADES_PER_IP_PER_MINUTE,
      period: 60,
    })
  })

  it('sends archived hands to the verify queue one per batch, with a dead-letter queue the Worker also consumes', () => {
    const { producers, consumers } = config.queues
    expect(producers).toEqual([
      { binding: 'HAND_QUEUE', queue: HANDS_QUEUE },
      { binding: 'HAND_DLQ', queue: HANDS_DLQ },
    ])
    expect(consumers).toEqual([
      {
        queue: HANDS_QUEUE,
        // The CPU limit is per invocation: one hand each.
        max_batch_size: 1,
        max_retries: 5,
        dead_letter_queue: HANDS_DLQ,
      },
      { queue: HANDS_DLQ, max_batch_size: 10 },
    ])
  })

  it('names every queue in a producer, so wrangler deploy creates any that are missing', () => {
    // wrangler (4.148) provisions queues named by producer bindings at deploy
    // and refuses a consumer or dead-letter queue that is not one.
    const produced = new Set(config.queues.producers.map((p) => p.queue))
    for (const consumer of config.queues.consumers) {
      expect(produced).toContain(consumer.queue)
      if (consumer.dead_letter_queue)
        expect(produced).toContain(consumer.dead_letter_queue)
    }
  })
})
