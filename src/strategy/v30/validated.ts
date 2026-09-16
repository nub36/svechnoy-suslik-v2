/**
 * V3.0 — the frozen validation record, shipped with the strategy so the admin
 * panel can show what was actually measured instead of a marketing summary.
 *
 * These numbers are COPIES of the committed artifacts:
 *   artifacts/research/v30/v30-train-metrics.json
 *   artifacts/research/v30/v30-validation-metrics.json
 *
 * `tests/v30-admin-wiring.test.ts` asserts they still match those files, so a
 * re-run that overwrites an artifact cannot silently leave the panel stale.
 *
 * ⚠️ READ THE QUALIFICATIONS. The VALIDATION PASS is an aggregate result. On
 * the validation window 3 of 6 symbols were negative, only two symbol cells
 * cleared the pre-registered n >= 100 rule (and they disagree in sign), and
 * removing the 5 best trades turns the net negative. `PRODUCTION_READY` is
 * forbidden; the 2026 TEST window has never been examined.
 */

import type { Settings } from '../../core/settings';
import { V30_FROZEN, v30Params, isFrozenConfiguration } from './params';

export interface ValidatedSubgroup {
  label: string;
  n: number;
  /** GROSS R per trade (before fees) — the only per-subgroup figure published. */
  grossExpectancyR: number;
}

export interface ValidatedWindowResult {
  /** Which split the numbers come from. */
  slice: 'TRAIN' | 'VALIDATION';
  window: string;
  n: number;
  tp1HitRatePct: number;
  tp2HitRatePct: number;
  stopDistancePctMedian: number;
  feeDragR: number;
  grossRPerTrade: number;
  netRPerTrade: number;
  netRPerTradeStress: number;
  profitFactor: number;
  maxDrawdownR: number;
  exTop1Pct: number;
  edgeRetainedPct: number;
  positiveRRatePct: number;
  /** Direction split; `grossExpectancyR` is GROSS. */
  byDirection: ValidatedSubgroup[];
  /** Per-symbol split; `grossExpectancyR` is GROSS. */
  bySymbol: ValidatedSubgroup[];
  /** Exit-reason histogram of the frozen candidate. */
  exits: Record<string, number>;
  verdict: string;
}

/** TRAIN (2022-01 … 2024-05). Source: v30-train-metrics.json. */
export const V30_TRAIN_RESULT: ValidatedWindowResult = {
  slice: 'TRAIN',
  window: '2022-01-01 … 2024-05-26',
  n: 1585,
  tp1HitRatePct: 48.26,
  tp2HitRatePct: 17.35,
  stopDistancePctMedian: 1.252,
  feeDragR: 0.0732,
  grossRPerTrade: 0.1726,
  netRPerTrade: 0.0994,
  netRPerTradeStress: 0.068,
  profitFactor: 1.3538,
  maxDrawdownR: -37.18,
  exTop1Pct: 0.0983,
  edgeRetainedPct: 57.0,
  positiveRRatePct: 50.73,
  byDirection: [
    { label: 'LONG', n: 796, grossExpectancyR: 0.1736 },
    { label: 'SHORT', n: 789, grossExpectancyR: 0.1717 },
  ],
  bySymbol: [
    { label: 'BTCUSDT', n: 259, grossExpectancyR: 0.2517 },
    { label: 'ETHUSDT', n: 268, grossExpectancyR: 0.252 },
    { label: 'BNBUSDT', n: 295, grossExpectancyR: 0.1387 },
    { label: 'SOLUSDT', n: 259, grossExpectancyR: 0.2841 },
    { label: 'XRPUSDT', n: 238, grossExpectancyR: 0.0386 },
    { label: 'DOGEUSDT', n: 266, grossExpectancyR: 0.0648 },
  ],
  exits: { TP1_THEN_BE: 410, TP2: 275, SL: 772, TP1_THEN_TIMEOUT: 80, TIMEOUT: 48 },
  verdict: 'TRAIN — both criteria met (pre-registered)',
};

/** VALIDATION (2024-05 … 2025-03). Source: v30-validation-metrics.json. */
export const V30_VALIDATION_RESULT: ValidatedWindowResult = {
  slice: 'VALIDATION',
  window: '2024-05-26 … 2025-03-14',
  n: 536,
  tp1HitRatePct: 47.39,
  tp2HitRatePct: 14.18,
  stopDistancePctMedian: 1.2799,
  feeDragR: 0.0673,
  grossRPerTrade: 0.1274,
  netRPerTrade: 0.06,
  netRPerTradeStress: 0.0312,
  profitFactor: 1.2484,
  maxDrawdownR: -25.94,
  exTop1Pct: 0.0384,
  edgeRetainedPct: 30.1,
  positiveRRatePct: 48.69,
  byDirection: [
    { label: 'SHORT', n: 306, grossExpectancyR: 0.1602 },
    { label: 'LONG', n: 230, grossExpectancyR: 0.0837 },
  ],
  bySymbol: [
    { label: 'BTCUSDT', n: 107, grossExpectancyR: -0.0129 },
    { label: 'ETHUSDT', n: 101, grossExpectancyR: 0.4684 },
    { label: 'BNBUSDT', n: 77, grossExpectancyR: 0.4272 },
    { label: 'SOLUSDT', n: 90, grossExpectancyR: -0.0685 },
    { label: 'XRPUSDT', n: 87, grossExpectancyR: -0.0966 },
    { label: 'DOGEUSDT', n: 74, grossExpectancyR: 0.0542 },
  ],
  exits: { TP2: 76, TP1_THEN_BE: 157, SL: 274, TP1_THEN_TIMEOUT: 21, TIMEOUT: 8 },
  verdict: 'VALIDATION — PASS, net > 0 @2/5 bps and gross > 0',
};

export const V30_VALIDATED_RESULTS: readonly ValidatedWindowResult[] = [
  V30_TRAIN_RESULT,
  V30_VALIDATION_RESULT,
];

/**
 * The frozen candidate's non-configurable constants, shown read-only in the
 * admin panel. They live in `params.ts` (or the registry) — this block only
 * repeats them so the panel can never disagree with the engine about what the
 * tested configuration was.
 */
export const V30_FROZEN_SURFACE = {
  corridorExpiryBars: 3,
  feeModel: 'maker 2 bps entry / taker 5 bps per exit leg',
  swingLookbackSetting: 'engine.swing_lookback',
  atrPeriodSetting: 'risk.atr_period',
  volumePeriodSetting: 'v2.volume_period',
  intrabarRules: 'R1–R5, non-configurable',
} as const;

/**
 * sha256 of `research/v30_htf_trap.ts` — the file the validated artifact is
 * attached to. Pinned by tests/v30-validation.test.ts AND required by
 * docs/ADMIN_PANEL_SPEC.md §14.6. The production port must never be described
 * as "the validated strategy" if this file changes.
 */
export const V30_RESEARCH_SHA256 =
  'a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd';

/** Where the proof that the port matches the research module lives. */
export const V30_PARITY_ARTIFACT = 'artifacts/research/v30/v30-port-parity.json';

/** Caveats that must be shown wherever the results are shown. */
export const V30_CAVEATS: readonly string[] = [
  'Aggregate pass only: 3 of 6 symbols were negative on validation (BTC −0.0129, SOL −0.0685, XRP −0.0966), and only two symbol cells cleared n ≥ 100 — they disagree in sign.',
  'Outlier fragility: removing the best 5 of 536 trades turns the net negative (ex-top-1 % gross +0.0384 is BELOW the 0.0673 R fee drag).',
  'The pre-registered mechanism was falsified — the 4H stop did not widen and fee drag grew because the partial exit pays three legs. The edge\'s true driver is not modelled.',
  'Both the TRAIN and the VALIDATION windows are spent. Changing any parameter here produces an untested strategy, and re-reading those windows after such a change is forbidden.',
  'Forward testing is PAPER only. LIVE execution is locked; no code path in this repository can place an order.',
];

/** Configuration status for the admin panel. */
export interface V30ConfigStatus {
  frozen: boolean;
  /** Keys whose stored value differs from the validated value. */
  driftedKeys: string[];
  params: ReturnType<typeof v30Params>;
}

/**
 * Compare the live configuration with the validated one and list every
 * deviation by registry key, so the UI can name what was changed.
 */
export function v30ConfigStatus(settings: Settings): V30ConfigStatus {
  const p = v30Params(settings);
  const drifted: string[] = [];
  const cmp = (key: string, actual: unknown, frozen: unknown): void => {
    if (actual !== frozen) drifted.push(key);
  };
  cmp('v30.bodyRatioMin', p.bodyRatioMin, 0.35);
  cmp('v30.rvolMin', p.rvolMin, 1.25);
  cmp('v30.corridorATR', p.corridorAtr, 0.1);
  cmp('v30.slBufferATR', p.slBufferAtr, 0.15);
  cmp('v30.tp1Equilibrium', p.tp1Equilibrium, 0.5);
  cmp('v30.breakevenTrigger', p.breakevenTrigger, 'tp1');
  cmp('v30.timeoutBars', p.timeoutBars, 50);
  cmp('v30.positionSplitTP1', p.positionSplitTp1, 0.5);
  cmp('v30.htfTimeframe', p.htfTimeframe, '4h');
  cmp('v30.ltfTimeframe', p.ltfTimeframe, '1h');
  if (p.symbols.join(',') !== 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT') {
    drifted.push('v30.symbols');
  }
  // The fee pair is part of the tested configuration: the headline net R was
  // measured at 2/5 bps, so a different pair invalidates it just as surely as a
  // different corridor width.
  cmp('v30.makerBps', p.makerBps, V30_FROZEN.makerBps);
  cmp('v30.takerBps', p.takerBps, V30_FROZEN.takerBps);
  return { frozen: drifted.length === 0 && isFrozenConfiguration(p), driftedKeys: drifted, params: p };
}
