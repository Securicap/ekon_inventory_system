/**
 * Time is injected, never read inline.
 *
 * `Date.now()` scattered through domain code makes ledger behaviour untestable:
 * you cannot assert what a movement recorded without controlling the clock.
 * Every service takes a Clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test double. Advance it explicitly rather than sleeping. */
export function fixedClock(start: Date): Clock & { advance(ms: number): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
