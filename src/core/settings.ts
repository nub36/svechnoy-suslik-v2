/**
 * Settings registry — the single source of truth for every tunable knob.
 *
 * RULE: every entry in SETTINGS_REGISTRY must be READ BY THE ENGINE.
 * `consumedBy` documents where, and tests/settings-wiring.test.ts asserts that
 * each key is actually referenced by engine code (no decorative settings).
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { getDb } from '../db';
import type { DetectorId, Timeframe } from './types';
import { TIMEFRAMES } from './types';
import { assertAllowedMode } from './mode';

export interface SettingDef {
  key: string;
  type: 'number' | 'boolean' | 'string' | 'json';
  category: 'engine' | 'detectors' | 'risk' | 'market' | 'outcome' | 'system';
  label: string;
  description: string;
  default: unknown;
  min?: number;
  max?: number;
  editable?: boolean;
  /** Where in the engine this value is consumed. Enforced by test. */
  consumedBy: string[];
  /**
   * For keys read through a typed accessor (e.g. `settings.timeframes()`)
   * rather than by literal key. The wiring test accepts either form.
   */
  accessor?: string;
}

export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  // ---------------- engine ----------------
  {
    key: 'engine.trading_mode',
    type: 'string',
    category: 'engine',
    label: 'Trading mode',
    description: 'DRY_RUN or FORWARD_TEST. LIVE is locked and will be rejected.',
    default: 'FORWARD_TEST',
    accessor: 'tradingMode(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/engine-runner.ts', 'src/workers/strategy.worker.ts'],
  },
  {
    key: 'engine.enabled',
    type: 'boolean',
    category: 'engine',
    label: 'Engine enabled',
    description: 'Master switch. When false the strategy worker evaluates nothing.',
    default: true,
    consumedBy: ['src/strategy/engine-runner.ts'],
  },
  {
    key: 'engine.score_threshold',
    type: 'number',
    category: 'engine',
    label: 'Signal score threshold',
    description: 'Minimum normalized score (0-100) required to emit a signal.',
    default: 55,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/smart-money.ts'],
  },
  {
    key: 'engine.min_components',
    type: 'number',
    category: 'engine',
    label: 'Minimum confluences',
    description: 'Minimum number of distinct counted factors (confirmations) required.',
    default: 2,
    min: 1,
    max: 7,
    consumedBy: ['src/strategy/smart-money.ts'],
  },
  {
    key: 'engine.timeframes',
    type: 'json',
    category: 'engine',
    label: 'Active timeframes',
    description: 'Timeframes evaluated by the strategy worker.',
    default: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
    accessor: 'timeframes(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/engine-runner.ts', 'src/workers/market.worker.ts'],
  },
  {
    key: 'engine.lookback_candles',
    type: 'number',
    category: 'engine',
    label: 'Lookback candles',
    description: 'How many closed candles the detectors analyse.',
    default: 300,
    min: 60,
    max: 1000,
    consumedBy: ['src/strategy/engine-runner.ts', 'src/replay/runner.ts'],
  },
  {
    key: 'engine.swing_lookback',
    type: 'number',
    category: 'detectors',
    label: 'Swing pivot strength',
    description: 'Bars on each side required to confirm a swing pivot.',
    default: 3,
    min: 1,
    max: 10,
    consumedBy: ['src/strategy/detectors.ts', 'src/strategy/smart-money.ts', 'src/replay/runner.ts'],
  },

  // ---------------- Smart Money factors ----------------
  //
  // INDEPENDENT: BOS, ORDER_BLOCK, FVG, LIQUIDITY_SWEEP, RANGE_POSITION
  // CONTEXT:     INTERNAL_STRUCTURE
  // DERIVED:     OB_FVG_CONFLUENCE (small bonus weight ONLY — never re-adds
  //              the ORDER_BLOCK / FVG weights)
  //
  {
    key: 'detectors.BOS.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'BOS enabled',
    description: 'Break of Structure — close beyond a confirmed swing.',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.BOS.weight',
    type: 'number',
    category: 'detectors',
    label: 'BOS weight',
    description: 'Score weight for BOS.',
    default: 25,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.ORDER_BLOCK.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'Order Block enabled',
    description: 'Last opposite candle before an impulsive displacement.',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.ORDER_BLOCK.weight',
    type: 'number',
    category: 'detectors',
    label: 'Order Block weight',
    description: 'Score weight for Order Block.',
    default: 20,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.FVG.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'FVG enabled',
    description: 'Fair Value Gap — three-candle price imbalance.',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.FVG.weight',
    type: 'number',
    category: 'detectors',
    label: 'FVG weight',
    description: 'Score weight for FVG.',
    default: 15,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.LIQUIDITY_SWEEP.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'Liquidity Sweep enabled',
    description: 'Wick takes liquidity beyond a swing, close rejects back inside.',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.LIQUIDITY_SWEEP.weight',
    type: 'number',
    category: 'detectors',
    label: 'Liquidity Sweep weight',
    description: 'Score weight for Liquidity Sweep.',
    default: 15,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.RANGE_POSITION.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'Range Position enabled',
    description: 'Where price sits inside the dealing range (outer bands only).',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.RANGE_POSITION.weight',
    type: 'number',
    category: 'detectors',
    label: 'Range Position weight',
    description: 'Score weight for Range Position.',
    default: 10,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.INTERNAL_STRUCTURE.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'Internal Structure enabled',
    description: 'CONTEXT factor: bullish/bearish internal (minor leg) structure.',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.INTERNAL_STRUCTURE.weight',
    type: 'number',
    category: 'detectors',
    label: 'Internal Structure weight',
    description: 'Score weight for Internal Structure.',
    default: 8,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.OB_FVG_CONFLUENCE.enabled',
    type: 'boolean',
    category: 'detectors',
    label: 'OB + FVG Confluence enabled',
    description: 'DERIVED factor: order block overlapping an FVG. Bonus weight only.',
    default: true,
    consumedBy: ['src/strategy/smart-money.ts', 'src/strategy/scoring.ts'],
  },
  {
    key: 'detectors.OB_FVG_CONFLUENCE.weight',
    type: 'number',
    category: 'detectors',
    label: 'OB + FVG Confluence weight',
    description: 'Score weight for OB + FVG Confluence.',
    default: 7,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/scoring.ts'],
  },

  // ---------------- factor parameters ----------------
  {
    key: 'detectors.event_ttl_bars',
    type: 'number',
    category: 'detectors',
    label: 'Event freshness (bars)',
    description: 'Factor events older than this many bars are ignored.',
    default: 12,
    min: 1,
    max: 100,
    consumedBy: ['src/strategy/smart-money.ts'],
  },
  {
    key: 'detectors.bos_min_break_pct',
    type: 'number',
    category: 'detectors',
    label: 'BOS min break %',
    description: 'Close must exceed the broken swing by at least this % to count as a BOS.',
    default: 0,
    min: 0,
    max: 5,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.ob_min_displacement',
    type: 'number',
    category: 'detectors',
    label: 'Order block min displacement',
    description: 'Displacement candle body must be at least this multiple of the 20-bar average body.',
    default: 1.6,
    min: 1,
    max: 10,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.ob_lookback_bars',
    type: 'number',
    category: 'detectors',
    label: 'Order block scan depth',
    description: 'How many bars back to search for the opposite candle forming the order block.',
    default: 8,
    min: 1,
    max: 50,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.fvg_min_pct',
    type: 'number',
    category: 'detectors',
    label: 'Min FVG size %',
    description: 'Minimum gap size as % of price to qualify as an FVG.',
    default: 0.05,
    min: 0.001,
    max: 5,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.sweep_min_wick_ratio',
    type: 'number',
    category: 'detectors',
    label: 'Sweep min wick ratio',
    description: 'Rejection wick must be at least this fraction of the candle range (0-1).',
    default: 0,
    min: 0,
    max: 1,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.range_edge_band',
    type: 'number',
    category: 'detectors',
    label: 'Range position edge band',
    description: 'Outer fraction of the dealing range that counts as a directional edge (e.g. 0.35 = lower/upper 35%).',
    default: 0.35,
    min: 0.05,
    max: 0.5,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.internal_structure_strength',
    type: 'number',
    category: 'detectors',
    label: 'Internal structure pivot strength',
    description: 'Pivot strength for MINOR legs. Keep below the swing pivot strength so it does not duplicate BOS.',
    default: 1,
    min: 1,
    max: 5,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.internal_structure_legs',
    type: 'number',
    category: 'detectors',
    label: 'Internal structure legs',
    description: 'How many recent minor highs/lows are compared to judge internal structure.',
    default: 3,
    min: 2,
    max: 10,
    consumedBy: ['src/strategy/detectors.ts'],
  },
  {
    key: 'detectors.confluence_min_overlap_pct',
    type: 'number',
    category: 'detectors',
    label: 'OB+FVG min overlap %',
    description: 'Minimum overlap (% of the smaller zone) for an order block and FVG to count as confluence.',
    default: 20,
    min: 1,
    max: 100,
    consumedBy: ['src/strategy/detectors.ts'],
  },

  // ---------------- risk ----------------
  {
    key: 'risk.atr_period',
    type: 'number',
    category: 'risk',
    label: 'ATR period',
    description: 'ATR lookback. ATR is used for RISK ONLY, never confirmation.',
    default: 14,
    min: 2,
    max: 100,
    consumedBy: ['src/strategy/smart-money.ts'],
  },
  {
    key: 'risk.sl_atr_mult',
    type: 'number',
    category: 'risk',
    label: 'Stop-loss ATR multiple',
    description: 'Stop distance = ATR * this multiple.',
    default: 1.5,
    min: 0.1,
    max: 10,
    consumedBy: ['src/strategy/risk.ts'],
  },
  {
    key: 'risk.sl_policy',
    type: 'string',
    category: 'risk',
    label: 'Stop-loss policy',
    description:
      'ATR = stop at ATR x multiple. STRUCTURE = stop at the structural invalidation level. ' +
      'ATR_OR_STRUCTURE = whichever is further away (safest).',
    default: 'ATR_OR_STRUCTURE',
    accessor: 'slPolicy(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/risk.ts'],
  },
  {
    key: 'risk.tp1_r',
    type: 'number',
    category: 'risk',
    label: 'TP1 (R multiple)',
    description: 'First take-profit, expressed as a multiple of the initial risk.',
    default: 1,
    min: 0.1,
    max: 50,
    accessor: 'tpMultiples(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/risk.ts'],
  },
  {
    key: 'risk.tp2_r',
    type: 'number',
    category: 'risk',
    label: 'TP2 (R multiple)',
    description: 'Second take-profit, as a multiple of the initial risk. 0 disables it.',
    default: 2,
    min: 0,
    max: 50,
    accessor: 'tpMultiples(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/risk.ts'],
  },
  {
    key: 'risk.tp3_r',
    type: 'number',
    category: 'risk',
    label: 'TP3 (R multiple)',
    description: 'Third take-profit, as a multiple of the initial risk. 0 disables it.',
    default: 3,
    min: 0,
    max: 50,
    accessor: 'tpMultiples(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/risk.ts'],
  },
  {
    key: 'risk.signal_expiry_bars',
    type: 'number',
    category: 'risk',
    label: 'Signal expiration (bars)',
    description:
      'A WAITING_ENTRY signal is cancelled if candle N+1 has still not arrived after this many bars. 0 = never expire.',
    default: 3,
    min: 0,
    max: 100,
    consumedBy: ['src/strategy/engine-runner.ts'],
  },
  {
    key: 'risk.account_quote',
    type: 'number',
    category: 'risk',
    label: 'Paper account size (USDT)',
    description: 'Virtual account equity used for position sizing.',
    default: 10000,
    min: 10,
    max: 100000000,
    consumedBy: ['src/strategy/risk.ts'],
  },
  {
    key: 'risk.risk_pct',
    type: 'number',
    category: 'risk',
    label: 'Risk per trade %',
    description: 'Percentage of the paper account risked per signal.',
    default: 1,
    min: 0.01,
    max: 100,
    consumedBy: ['src/strategy/risk.ts'],
  },
  {
    key: 'risk.max_concurrent',
    type: 'number',
    category: 'risk',
    label: 'Max concurrent positions',
    description: 'Max simultaneously ACTIVE/WAITING_ENTRY signals.',
    default: 8,
    min: 1,
    max: 200,
    consumedBy: ['src/strategy/engine-runner.ts'],
  },
  {
    key: 'risk.min_rr',
    type: 'number',
    category: 'risk',
    label: 'Minimum R:R for TP1',
    description: 'Signals whose TP1 R:R is below this are rejected.',
    default: 1,
    min: 0.1,
    max: 20,
    consumedBy: ['src/strategy/engine-runner.ts'],
  },

  // ---------------- market ----------------
  {
    key: 'market.top_n',
    type: 'number',
    category: 'market',
    label: 'TOP-N symbols',
    description: 'Number of Binance Spot USDT pairs tracked by 24h quote volume.',
    default: 10,
    min: 1,
    max: 50,
    consumedBy: ['src/workers/market.worker.ts', 'src/market/top-symbols.ts'],
  },
  {
    key: 'market.quote_asset',
    type: 'string',
    category: 'market',
    label: 'Quote asset',
    description: 'Quote currency filter. Locked to USDT by architecture.',
    default: 'USDT',
    editable: false,
    consumedBy: ['src/market/top-symbols.ts'],
  },
  {
    key: 'market.exclude_symbols',
    type: 'json',
    category: 'market',
    label: 'Excluded symbols',
    description:
      'Symbols never ranked into the TOP-N (stablecoin and fiat-like pairs). ' +
      'Configurable: this is NOT a hardcoded TOP-10 list, it is an exclusion filter.',
    default: [
      'USDCUSDT',
      'FDUSDUSDT',
      'TUSDUSDT',
      'BUSDUSDT',
      'USDPUSDT',
      'USD1USDT',
      'EURUSDT',
      'GBPUSDT',
      'AEURUSDT',
      'DAIUSDT',
      'SUSDUSDT',
      'PYUSDUSDT',
    ],
    consumedBy: ['src/market/top-symbols.ts'],
  },
  {
    key: 'market.enabled_symbols',
    type: 'json',
    category: 'market',
    label: 'Enabled symbols',
    description:
      'Restrict the engine to these symbols (must still be in the TOP-N). ' +
      'Empty = trade the whole TOP-N. This is a filter, never a hardcoded list.',
    default: [],
    accessor: 'enabledSymbols(',
    consumedBy: ['src/core/settings.ts', 'src/strategy/engine-runner.ts'],
  },
  {
    key: 'market.candle_limit',
    type: 'number',
    category: 'market',
    label: 'Candles fetched per poll',
    description: 'Klines requested from Binance per symbol/timeframe.',
    default: 500,
    min: 50,
    max: 1000,
    consumedBy: ['src/workers/market.worker.ts'],
  },
  {
    key: 'market.refresh_top_minutes',
    type: 'number',
    category: 'market',
    label: 'TOP-N refresh (minutes)',
    description: 'How often the TOP-N symbol list is recomputed.',
    default: 30,
    min: 1,
    max: 1440,
    consumedBy: ['src/workers/market.worker.ts'],
  },

  // ---------------- outcome ----------------
  {
    key: 'outcome.timeout_bars',
    type: 'number',
    category: 'outcome',
    label: 'Timeout (bars)',
    description: 'Close an ACTIVE signal as TIMEOUT after this many bars.',
    default: 48,
    min: 1,
    max: 2000,
    consumedBy: ['src/outcome/tracker.ts'],
  },
  {
    key: 'outcome.sl_priority_on_ambiguous_bar',
    type: 'boolean',
    category: 'outcome',
    label: 'SL wins ambiguous bar',
    description:
      'If one candle touches both SL and TP, assume the worst case (SL). Conservative and prevents optimistic bias.',
    default: true,
    consumedBy: ['src/outcome/tracker.ts'],
  },
  {
    key: 'outcome.fee_pct',
    type: 'number',
    category: 'outcome',
    label: 'Round-trip fee %',
    description: 'Simulated taker fee applied to PnL (entry + exit).',
    default: 0.1,
    min: 0,
    max: 5,
    consumedBy: ['src/outcome/tracker.ts'],
  },

  // ---------------- system ----------------
  {
    key: 'system.log_retention_rows',
    type: 'number',
    category: 'system',
    label: 'Engine log retention (rows)',
    description: 'Engine log is trimmed to this many rows.',
    default: 5000,
    min: 100,
    max: 200000,
    consumedBy: ['src/core/logger.ts'],
  },
  {
    key: 'system.candle_retention_per_series',
    type: 'number',
    category: 'system',
    label: 'Candle retention per series',
    description: 'Max candles kept per symbol/timeframe.',
    default: 1500,
    min: 300,
    max: 20000,
    consumedBy: ['src/workers/market.worker.ts'],
  },
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(
  SETTINGS_REGISTRY.map((s) => [s.key, s]),
);

export type SettingsMap = Map<string, unknown>;

/** Strongly-typed accessor over a loaded settings snapshot. */
export class Settings {
  constructor(private readonly map: SettingsMap) {}

  static fromDefaults(): Settings {
    return new Settings(new Map(SETTINGS_REGISTRY.map((s) => [s.key, s.default])));
  }

  static fromEntries(entries: Iterable<readonly [string, unknown]>): Settings {
    const m = new Map<string, unknown>(SETTINGS_REGISTRY.map((s) => [s.key, s.default]));
    for (const [k, v] of entries) m.set(k, v);
    return new Settings(m);
  }

  raw(): SettingsMap {
    return new Map(this.map);
  }

  toObject(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }

  num(key: string): number {
    const v = this.map.get(key);
    const n = typeof v === 'string' ? Number(v) : (v as number);
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      const def = SETTINGS_BY_KEY.get(key)?.default;
      return typeof def === 'number' ? def : 0;
    }
    return n;
  }

  bool(key: string): boolean {
    const v = this.map.get(key);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true';
    return Boolean(SETTINGS_BY_KEY.get(key)?.default);
  }

  str(key: string): string {
    const v = this.map.get(key);
    if (typeof v === 'string') return v;
    const def = SETTINGS_BY_KEY.get(key)?.default;
    return typeof def === 'string' ? def : '';
  }

  arr<T>(key: string): T[] {
    const v = this.map.get(key);
    if (Array.isArray(v)) return v as T[];
    const def = SETTINGS_BY_KEY.get(key)?.default;
    return Array.isArray(def) ? ([...def] as T[]) : [];
  }

  /** Active timeframes, validated against the supported set. */
  timeframes(): Timeframe[] {
    const raw = this.arr<string>('engine.timeframes');
    const valid = raw.filter((t): t is Timeframe => (TIMEFRAMES as readonly string[]).includes(t));
    return valid.length > 0 ? valid : ['15m', '1h', '4h'];
  }

  detectorEnabled(d: DetectorId): boolean {
    return this.bool(`detectors.${d}.enabled`);
  }

  detectorWeight(d: DetectorId): number {
    return this.num(`detectors.${d}.weight`);
  }

  /**
   * Take-profit R multiples, from the explicit TP1/TP2/TP3 settings.
   * Zero (or negative) disables a level; the list is sorted ascending.
   */
  tpMultiples(): number[] {
    const raw = [this.num('risk.tp1_r'), this.num('risk.tp2_r'), this.num('risk.tp3_r')];
    const tps = raw.filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
    return tps.length > 0 ? tps : [1];
  }

  /** Stop-loss policy. Unknown values degrade to the safest option. */
  slPolicy(): 'ATR' | 'STRUCTURE' | 'ATR_OR_STRUCTURE' {
    const v = this.str('risk.sl_policy');
    return v === 'ATR' || v === 'STRUCTURE' ? v : 'ATR_OR_STRUCTURE';
  }

  /**
   * Symbols the engine is allowed to trade. Empty list (the default) means
   * "whatever the market worker ranked into the TOP-N".
   */
  enabledSymbols(): string[] {
    return this.arr<string>('market.enabled_symbols')
      .map((x) => String(x).toUpperCase().trim())
      .filter((x) => x.length > 0);
  }

  tradingMode(): 'DRY_RUN' | 'FORWARD_TEST' {
    // Never allows LIVE — assertAllowedMode throws, we degrade to DRY_RUN.
    try {
      return assertAllowedMode(this.str('engine.trading_mode'));
    } catch {
      return 'DRY_RUN';
    }
  }
}

/** Load the full settings snapshot from the DB, falling back to defaults. */
export async function loadSettings(db: Kysely<Database> = getDb()): Promise<Settings> {
  const rows = await db.selectFrom('settings').select(['key', 'value']).execute();
  return Settings.fromEntries(rows.map((r) => [r.key, r.value] as const));
}

/** Validate + coerce a value against its registry definition. */
export function coerceSettingValue(def: SettingDef, input: unknown): unknown {
  switch (def.type) {
    case 'number': {
      const n = typeof input === 'string' ? Number(input) : (input as number);
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new Error(`${def.key}: expected a number`);
      }
      if (def.min !== undefined && n < def.min) throw new Error(`${def.key}: min is ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new Error(`${def.key}: max is ${def.max}`);
      return n;
    }
    case 'boolean': {
      if (typeof input === 'boolean') return input;
      if (input === 'true') return true;
      if (input === 'false') return false;
      throw new Error(`${def.key}: expected a boolean`);
    }
    case 'string': {
      if (def.key === 'risk.sl_policy') {
        const allowed = ['ATR', 'STRUCTURE', 'ATR_OR_STRUCTURE'];
        if (typeof input !== 'string' || !allowed.includes(input)) {
          throw new Error(`risk.sl_policy: must be one of ${allowed.join(', ')}`);
        }
      }
      if (typeof input !== 'string') throw new Error(`${def.key}: expected a string`);
      if (def.key === 'engine.trading_mode') {
        // Throws for LIVE — the lock is enforced at the settings boundary too.
        return assertAllowedMode(input);
      }
      if (def.key === 'market.quote_asset' && input !== 'USDT') {
        throw new Error('market.quote_asset is locked to USDT (Binance Spot USDT only)');
      }
      return input;
    }
    case 'json': {
      let v = input;
      if (typeof input === 'string') {
        try {
          v = JSON.parse(input);
        } catch {
          throw new Error(`${def.key}: invalid JSON`);
        }
      }
      if (def.key === 'engine.timeframes') {
        if (!Array.isArray(v) || v.length === 0) {
          throw new Error('engine.timeframes: expected a non-empty array');
        }
        for (const t of v) {
          if (!(TIMEFRAMES as readonly string[]).includes(String(t))) {
            throw new Error(`engine.timeframes: unsupported timeframe "${String(t)}"`);
          }
        }
      }
      if (def.key === 'market.enabled_symbols' || def.key === 'market.exclude_symbols') {
        if (!Array.isArray(v)) {
          throw new Error(`${def.key}: expected an array of symbols`);
        }
        for (const sym of v) {
          if (typeof sym !== 'string' || !/^[A-Z0-9]{2,20}$/.test(sym.toUpperCase())) {
            throw new Error(`${def.key}: invalid symbol "${String(sym)}"`);
          }
        }
      }
      return v;
    }
    default:
      throw new Error(`${def.key}: unknown type`);
  }
}
