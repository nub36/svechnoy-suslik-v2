/**
 * V3.0 HTF LIQUIDATION TRAP — public surface of the ported strategy.
 *
 * This module is the PRODUCTION port of the validated research implementation
 * (`research/v30_htf_trap.ts`, frozen hash a821757f…). The research file is not
 * modified: it remains the record the validated artifact is attached to.
 *
 * Read docs/strategies/V3_0_HTF_LIQUIDATION_TRAP.md for the rules and
 * docs/V3_0_VALIDATION_RESULTS.md for what the validation did and did not
 * establish.
 */

export {
  ACTIVE_STRATEGIES,
  V30_BREAKEVEN_OPTIONS,
  V30_FROZEN,
  V30_HTF_OPTIONS,
  V30_LTF_OPTIONS,
  isFrozenConfiguration,
  v30Params,
  type ActiveStrategy,
  type V30BreakevenTrigger,
  type V30Params,
} from './params';

export { activeRange, confirmedLevels, type TrapLevels } from './levels';
export { bodyRatio, detectTrap, type Direction, type TrapSignal } from './trap';
export {
  buildPlan,
  corridorStep,
  legFeeR,
  manageTrade,
  type CorridorDecision,
  type ExitReason,
  type FeeLeg,
  type V30Plan,
  type V30Trade,
} from './execution';

export {
  advanceCorridor,
  planPayload,
  readPlan,
  riskReward,
  runV30Once,
  sizePosition,
  V30_LIVE_STATES,
  type V30RunResult,
  type V30SignalPlan,
  type V30SymbolStatus,
} from './runner';

export {
  resolveV30Outcome,
  signalStateFor,
  v30Milestones,
  type V30Milestones,
  type V30Outcome,
} from './outcome';

export {
  V30_CAVEATS,
  V30_FROZEN_SURFACE,
  V30_PARITY_ARTIFACT,
  V30_RESEARCH_SHA256,
  V30_TRAIN_RESULT,
  V30_VALIDATED_RESULTS,
  V30_VALIDATION_RESULT,
  v30ConfigStatus,
  type ValidatedSubgroup,
  type ValidatedWindowResult,
  type V30ConfigStatus,
} from './validated';
