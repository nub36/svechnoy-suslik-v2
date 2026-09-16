/**
 * Arm definitions shared by the timeframe/cost diagnostic.
 * Re-exports the corridor replay so the diagnostic stays a thin driver.
 */
import type { Gates } from './corridor-replay';

export { replayCorridor } from './corridor-replay';
export type { Gates, CorridorTrade } from './corridor-replay';

/** Only the two arms the diagnostic needs: frozen baseline and the full stack. */
export const ARMS_A_FULL: Record<string, Gates> = {
  A:    { extreme: false, feeGuard: false, confluence: false, corridor: false },
  FULL: { extreme: true,  feeGuard: true,  confluence: true,  corridor: true  },
};
