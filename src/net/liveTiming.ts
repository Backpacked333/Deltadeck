import type { SeatView } from '../shared/protocol'

export type RenderIdentity = {
  tableId: string
  matchId: string
  handNo: number | null
  actionIndex: number | null
  stateVersion: number
}
export type TimingSample = {
  phase: 'intent' | 'sent' | 'acknowledgement' | 'frame' | 'render'
  at: number
  identity: RenderIdentity
  requestId?: string
  frameId?: number
}

export function renderIdentity(
  tableId: string,
  matchId: string,
  stateVersion: number,
  view: SeatView | null,
): RenderIdentity {
  return {
    tableId,
    matchId,
    stateVersion,
    handNo: view?.handNo ?? null,
    actionIndex: view?.actions.length ?? null,
  }
}

/** Local, bounded diagnostics only. No cards, names, responses or wall clocks. */
export class LiveTiming {
  private samples: TimingSample[] = []
  constructor(private readonly now: () => number) {}
  mark(sample: Omit<TimingSample, 'at'>) {
    const entry = { ...sample, at: this.now() }
    this.samples.push(entry)
    if (this.samples.length > 256) this.samples.shift()
    if (typeof window !== 'undefined')
      window.dispatchEvent(new CustomEvent('qp:live-timing', { detail: entry }))
    return entry
  }
  read(): readonly TimingSample[] {
    return this.samples.slice()
  }
}
