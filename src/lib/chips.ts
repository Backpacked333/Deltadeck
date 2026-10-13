// Casino chip denominations and a greedy amount-to-stack breakdown, used to
// draw bets and pots as physical stacks.
export type Denomination = {
  value: number
  /** Main colour, edge-stripe colour. */
  color: string
  stripe: string
}

export const DENOMINATIONS: Denomination[] = [
  { value: 500, color: '#6b3fa0', stripe: '#f2e6ff' },
  { value: 100, color: '#23272b', stripe: '#f0d27a' },
  { value: 25, color: '#2f8a5b', stripe: '#f5f1e3' },
  { value: 5, color: '#c4413a', stripe: '#f5f1e3' },
  { value: 1, color: '#f1eee4', stripe: '#3a6ea5' },
]

export type ChipStack = { denomination: Denomination; count: number }

/**
 * Break an amount into stacks of the largest denominations first. Stacks are
 * capped for drawing (`maxPerStack`, `maxStacks`); `exact` reports whether
 * the drawing shows every chip.
 */
export function chipStacks(
  amount: number,
  { maxPerStack = 8, maxStacks = 4 } = {},
): { stacks: ChipStack[]; exact: boolean } {
  let rest = Math.max(0, Math.round(amount))
  const stacks: ChipStack[] = []
  for (const denomination of DENOMINATIONS) {
    const count = Math.floor(rest / denomination.value)
    if (!count) continue
    rest -= count * denomination.value
    stacks.push({ denomination, count })
  }
  const exact =
    stacks.length <= maxStacks && stacks.every((s) => s.count <= maxPerStack)
  return {
    stacks: stacks
      .slice(0, maxStacks)
      .map((s) => ({ ...s, count: Math.min(s.count, maxPerStack) })),
    exact,
  }
}

/** Total value of a breakdown (before any drawing caps). */
export const stackValue = (stacks: ChipStack[]) =>
  stacks.reduce((sum, s) => sum + s.count * s.denomination.value, 0)
