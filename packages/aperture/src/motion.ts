/**
 * ------------------------------------------------------------------
 *  Title    |  Springs
 *  Ref      |  DESIGN-UI.md §2 (motion)
 *  ID       |  aperture
 * ------------------------------------------------------------------
 *  Purpose  |  The few springs the interface moves on, named by
 *           |  character so a component asks for "snappy", never for
 *           |  numbers. Motion (motion/react) reads them directly.
 *  How      |  visualDuration is the time it feels like; bounce stays
 *           |  near zero for anything used often. Delight (playful) is
 *           |  for rare moments only: a pin, a seal, a milestone.
 * ------------------------------------------------------------------
 */

export const spring = {
  /** Toggles, tab underlines, sliding highlights. */
  snappy: { type: 'spring', visualDuration: 0.18, bounce: 0 },
  /** Popovers, drawers, layout moves. The default. */
  smooth: { type: 'spring', visualDuration: 0.32, bounce: 0.08 },
  /** Dialogs, onboarding, the help sheet. */
  gentle: { type: 'spring', visualDuration: 0.5, bounce: 0.12 },
  /** Rare delight: pinning, the verified seal, milestones. */
  playful: { type: 'spring', stiffness: 520, damping: 24, mass: 0.7 },
  /** Number tickers. */
  ticker: { type: 'spring', stiffness: 180, damping: 26 },
} as const;

/** Exits run at 70% of their entry, on a short ease-in. */
export const exit = { duration: 0.14, ease: [0.4, 0, 1, 1] } as const;

export const ease = {
  out: [0.23, 1, 0.32, 1],
  inOut: [0.77, 0, 0.175, 1],
  sheet: [0.32, 0.72, 0, 1],
  family: [0.19, 1, 0.22, 1],
} as const;
