// Where the rail light (TableScene) starts for a seat.

/** Where the light starts for a seat, in degrees clockwise from the top. */
export const railFrom = {
  hero: 180,
  opponent: 0,
  /** Six seats, by slot: 0 at the bottom, then clockwise. */
  slot: (slot: number) => (180 + slot * 60) % 360,
}
