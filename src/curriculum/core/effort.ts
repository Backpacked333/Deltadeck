export interface EffortSnapshot {
  version: 1
  provenance: 'client-monotonic'
  activeMs: number
  visibleMs: number
  sessions: number
}

/** Interaction-qualified visible time; not proof of attention or honest effort. */
export class EffortClock {
  private last: number
  private interaction: number
  private visible: boolean
  private value: EffortSnapshot
  constructor(
    prior?: EffortSnapshot,
    private now = () => performance.now(),
    visible = true,
  ) {
    this.last = this.interaction = now()
    this.visible = visible
    this.value = {
      version: 1,
      provenance: 'client-monotonic',
      activeMs: prior?.activeMs ?? 0,
      visibleMs: prior?.visibleMs ?? 0,
      sessions: (prior?.sessions ?? 0) + 1,
    }
  }
  snapshot(): EffortSnapshot {
    const at = this.now()
    if (this.visible) {
      this.value.visibleMs += Math.max(0, at - this.last)
      this.value.activeMs += Math.max(
        0,
        Math.min(at, this.interaction + 60_000) - this.last,
      )
    }
    this.last = at
    return {
      ...this.value,
      activeMs: Math.round(this.value.activeMs),
      visibleMs: Math.round(this.value.visibleMs),
    }
  }
  interact() {
    this.snapshot()
    this.interaction = this.now()
  }
  visibility(visible: boolean) {
    this.snapshot()
    this.visible = visible
    if (visible) this.interaction = this.now()
  }
}
