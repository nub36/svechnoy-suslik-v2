/**
 * Chart overlay construction — BACKEND ONLY.
 *
 * The frontend receives ready-to-draw geometry and never runs any Smart Money
 * logic itself. Every zone/line/marker here comes from the same `evaluate()`
 * call the live engine uses.
 *
 * This module is also responsible for VISUAL DECLUTTERING: the raw evaluation
 * can contain dozens of events clustered on a handful of bars, which produces
 * an unreadable wall of overlapping labels. The rules applied here:
 *
 *   1. Only the strongest event per (factor, direction, dedupeKey) survives.
 *   2. Markers are capped per factor and globally, strongest first.
 *   3. Markers landing on the same bar are collapsed into one compact label.
 *   4. Zones are capped so translucent boxes never bury the candles.
 *   5. Labels are compact ("BOS", "SWEEP", "OB+FVG"), not full factor names.
 *
 * The score itself is NEVER affected by decluttering — that is decided by
 * scoring.ts. This only governs what is drawn.
 */

import type { Candle, FactorId, Evaluation, Timeframe } from '../core/types';
import { evaluateV2IfEnabled } from '../strategy/v2';
import type { V2Setup } from '../strategy/v2/types';
import { FACTOR_LABEL } from '../core/types';
import type { Settings } from '../core/settings';
import { evaluate } from '../strategy/smart-money';
import { explain } from '../strategy/scoring';

export interface OverlayBox {
  id: string;
  detector: FactorId;
  direction: 'LONG' | 'SHORT';
  from: number;
  to: number;
  priceLow: number;
  priceHigh: number;
  label: string;
  reason: string;
  strength: number;
}

export interface OverlayLine {
  id: string;
  detector: FactorId;
  direction: 'LONG' | 'SHORT';
  from: number;
  to: number;
  price: number;
  label: string;
  reason: string;
  strength: number;
}

export interface OverlayMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  text: string;
  detector: FactorId;
  /** How many events this marker represents after grouping. */
  groupCount?: number;
}

/** A price level belonging to a real persisted signal (entry/SL/TPs). */
export interface SignalLevel {
  kind: 'ENTRY' | 'SL' | 'TP1' | 'TP2' | 'TP3';
  price: number;
  label: string;
  color: string;
}

export interface SignalOverlay {
  id: number;
  direction: 'LONG' | 'SHORT';
  state: string;
  score: number;
  setupCandleTime: number;
  entryCandleTime: number | null;
  /** null while WAITING_ENTRY — an entry is NEVER fabricated. */
  entryPrice: number | null;
  levels: SignalLevel[];
  waitingForEntry: boolean;
  /**
   * True when no live signal exists for this symbol/timeframe and this is the
   * most recent FINISHED one (TP3_HIT / STOPPED / EXPIRED). Historical signals
   * carry no active price levels and must be rendered distinctly from a
   * position that is currently running.
   */
  historical?: boolean;
}

export interface ChartOverlays {
  boxes: OverlayBox[];
  lines: OverlayLine[];
  markers: OverlayMarker[];
  /** Factor ids actually present, for the chart legend. */
  legend: Array<{ detector: FactorId; label: string; color: string; kind: string }>;
}

export interface ChartPayload {
  symbol: string;
  timeframe: Timeframe;
  /**
   * Binance PRICE_FILTER tickSize for this symbol. Drives display precision on
   * the price axis, the crosshair and every ENTRY/SL/TP label, so the chart
   * agrees with the tables. null when the symbol metadata is unknown.
   */
  tickSize: number | null;
  candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isClosed: boolean;
  }>;
  overlays: ChartOverlays;
  evaluation: {
    candleTime: number;
    closePrice: number;
    atr: number | null;
    long: Evaluation['long'];
    short: Evaluation['short'];
    longScore: number;
    shortScore: number;
    confirmations: number;
    decision: Evaluation['decision'];
    explainLong: string[];
    explainShort: string[];
  } | null;
  /**
   * SMC V2 research diagnostics. Null unless `v2.enabled` is switched on.
   * V2 does NOT drive signals; this block is for inspection only, which is why
   * `direction` may be WAIT and carries `waitReasons`.
   */
  v2: V2Diagnostics | null;
  /** The live signal for this symbol/timeframe, if one exists. */
  signal: SignalOverlay | null;
  /** How many of the returned candles are closed (the engine only sees these). */
  closedCount: number;
}

/** Compact, UI-ready view of a V2 setup. */
export interface V2Diagnostics {
  direction: 'LONG' | 'SHORT' | 'WAIT';
  setup: 'REVERSAL' | 'CONTINUATION' | null;
  location: 'HIGH' | 'LOW' | 'MID';
  phase: string;
  bias: string;
  /** 0..1 evidence — NOT a probability, never render it as a percentage. */
  longEvidence: number;
  shortEvidence: number;
  conflict: number;
  range: { high: number; low: number; mid: number; confidence: number } | null;
  equilibrium: number | null;
  fibZone: string | null;
  rows: Array<{ label: string; value: string; detail?: string }>;
  reasons: string[];
  waitReasons: string[];
  levels: {
    entry: number | null;
    stop: number | null;
    stopReason: string | null;
    targets: Array<{ price: number; basis: string; r: number; reason: string }>;
  };
}

const f2 = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : v.toFixed(2);

/**
 * Turn a V2 setup into the labelled diagnostic rows the spec asks for.
 * Every row is a measured fact; nothing here is decorative.
 */
export function buildV2Diagnostics(s: V2Setup): V2Diagnostics {
  const dirProfile = s.direction === 'SHORT' ? s.shortProfile : s.longProfile;
  const rows: Array<{ label: string; value: string; detail?: string }> = [
    {
      label: 'Структура',
      value: s.bias === 'BULLISH' ? 'Бычья' : s.bias === 'BEARISH' ? 'Медвежья' : 'Диапазон',
      detail: s.structureBreak
        ? `${s.structureBreak.wickOnly ? 'Только фитиль (не пробой)' : s.structureBreak.type} ${s.structureBreak.direction}`
        : 'Нет подтверждённого слома',
    },
    {
      label: 'Ликвидность',
      value: s.sweep ? `Снятие ${s.sweep.side === 'BUY_SIDE' ? 'сверху' : 'снизу'}` : 'Нет снятия',
      detail: s.sweep
        ? `${f2(s.sweep.penetrationAtr)} ATR, возврат через ${s.sweep.reclaimBars} бар(ов), качество ${f2(s.sweep.quality)}`
        : undefined,
    },
    {
      label: 'Пробой',
      value: s.breakout ? (s.breakout.held ? 'Удерживается' : 'Возврат внутрь') : 'Нет',
      detail: s.breakout
        ? `закрытие ${f2(s.breakout.closeBeyondAtr)} ATR за уровень, качество ${f2(s.breakout.quality)}`
        : undefined,
    },
    {
      label: 'Импульс (displacement)',
      value: s.displacement ? `${f2(s.displacement.bodyAtr)} ATR` : 'Нет',
      detail: s.displacement ? `сила ${f2(s.displacement.strength)}` : undefined,
    },
    {
      label: 'OB / FVG',
      value: `${s.orderBlock ? 'OB' : '—'} / ${s.fvg ? 'FVG' : '—'}`,
      detail: [
        s.orderBlock ? `OB ${s.orderBlock.state}` : null,
        s.fvg ? `FVG ${s.fvg.state}` : null,
      ].filter(Boolean).join(', ') || undefined,
    },
    {
      label: 'Объём (RVOL)',
      value: s.vol.rvol === null ? '—' : `${f2(s.vol.rvol)}x`,
      detail: s.vol.spike ? 'всплеск объёма' : undefined,
    },
    {
      label: 'Старший ТФ',
      value:
        s.htfAlignment === 'ALIGNED' ? 'По тренду'
        : s.htfAlignment === 'COUNTER_TREND' ? 'Против тренда'
        : s.htfAlignment === 'NEUTRAL' ? 'Нейтрально' : 'Нет данных',
      detail: s.htf.filter((h) => h.available).map((h) => `${h.timeframe}: ${h.bias}`).join(', ') || undefined,
    },
    {
      label: 'EMA',
      value: s.ema.alignment === 'BULLISH' ? 'Бычья' : s.ema.alignment === 'BEARISH' ? 'Медвежья' : 'Смешанная',
      detail: s.ema.ema20 !== null ? `EMA20 ${f2(s.ema.ema20)}` : undefined,
    },
    {
      label: 'MACD',
      value: s.macd.histogram === null ? '—' : s.macd.histogram > 0 ? 'Бычий' : 'Медвежий',
      detail: s.macd.accelerating ? 'ускорение' : undefined,
    },
    {
      label: 'RSI',
      value: s.rsi.rsi === null ? '—' : f2(s.rsi.rsi),
      detail: s.rsi.bullishDivergence ? 'бычья дивергенция'
        : s.rsi.bearishDivergence ? 'медвежья дивергенция'
        : s.rsi.overbought ? 'перекупленность (не сигнал на SHORT)'
        : s.rsi.oversold ? 'перепроданность (не сигнал на LONG)' : undefined,
    },
    {
      label: 'ADX / волатильность',
      value: s.adx.adx === null ? '—' : `${f2(s.adx.adx)} (${s.adx.regime})`,
      detail: `ATR режим: ${s.atr.regime}`,
    },
    {
      label: 'Место до цели',
      value: s.room
        ? `TP1 ${f2(s.room.firstR)}R / далее ${f2(s.room.nextStructuralR)}R / итог ${f2(s.room.finalR)}R`
        : '—',
      detail: s.room
        ? `${s.room.reason}. Расстояние до финальной цели: ${f2(s.room.atrDistance)} ATR`
        : undefined,
    },
  ];

  return {
    direction: s.direction,
    setup: s.kind,
    location: s.location,
    phase: s.phase,
    bias: s.bias,
    longEvidence: s.longEvidence,
    shortEvidence: s.shortEvidence,
    conflict: s.conflict,
    range: s.range
      ? { high: s.range.high, low: s.range.low, mid: s.range.mid, confidence: s.range.confidence }
      : null,
    equilibrium: s.fib?.level500 ?? null,
    fibZone: s.fib?.zone ?? null,
    rows: rows.map((r) => ({
      label: r.label,
      value: r.value,
      ...(r.detail === undefined ? {} : { detail: r.detail }),
    })),
    reasons: s.reasons,
    waitReasons: s.waitReasons,
    levels: {
      entry: s.entry,
      stop: s.stop?.price ?? null,
      stopReason: s.stop?.reason ?? null,
      targets: s.targets.map((t) => ({
        price: t.price, basis: t.basis, r: t.r, reason: t.reason,
      })),
    },
  };
}

/**
 * Restrained, visually distinct palette — one colour per ACTIVE factor.
 * Removed factors (change-of-character, equal levels, volume imbalance,
 * premium/discount) intentionally have no entry here.
 */
const COLOR: Record<FactorId, string> = {
  BOS: '#22c55e',
  ORDER_BLOCK: '#3b82f6',
  FVG: '#a855f7',
  LIQUIDITY_SWEEP: '#ef4444',
  RANGE_POSITION: '#14b8a6',
  INTERNAL_STRUCTURE: '#94a3b8',
  OB_FVG_CONFLUENCE: '#f59e0b',
};

/** Short labels so chart markers stay compact and do not overlap. */
const SHORT_LABEL: Record<FactorId, string> = {
  BOS: 'BOS',
  ORDER_BLOCK: 'OB',
  FVG: 'FVG',
  LIQUIDITY_SWEEP: 'SWEEP',
  RANGE_POSITION: 'RANGE',
  INTERNAL_STRUCTURE: 'STRUCT',
  OB_FVG_CONFLUENCE: 'OB+FVG',
};

export function detectorColor(d: FactorId): string {
  return COLOR[d] ?? '#94a3b8';
}

export function detectorShortLabel(d: FactorId): string {
  return SHORT_LABEL[d] ?? d;
}

/** Factors that get an arrow marker on their confirming candle. */
const MARKER_FACTORS: readonly FactorId[] = ['BOS', 'LIQUIDITY_SWEEP', 'OB_FVG_CONFLUENCE'];

/** Decluttering caps. */
const MAX_MARKERS_PER_FACTOR = 4;
const MAX_MARKERS_TOTAL = 12;
const MAX_BOXES_PER_FACTOR = 3;
const MAX_BOXES_TOTAL = 10;
const MAX_LINES_TOTAL = 8;

function capPerFactor<T extends { detector: FactorId; strength: number }>(
  items: T[],
  perFactor: number,
  total: number,
): T[] {
  const byFactor = new Map<FactorId, T[]>();
  for (const it of items) {
    const list = byFactor.get(it.detector) ?? [];
    list.push(it);
    byFactor.set(it.detector, list);
  }
  const kept: T[] = [];
  for (const [, list] of byFactor) {
    list.sort((a, b) => b.strength - a.strength);
    kept.push(...list.slice(0, perFactor));
  }
  kept.sort((a, b) => b.strength - a.strength);
  return kept.slice(0, total);
}

/**
 * Build the full chart payload for a symbol/timeframe.
 * `candles` may include the forming bar — it is sent for display but the
 * evaluation below strictly uses closed candles only.
 */
export function buildChartPayload(
  symbol: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
  settings: Settings,
  signal?: SignalOverlay | null,
  tickSize?: number | null,
  /**
   * Higher-timeframe candles for the V2 diagnostic panel only.
   *
   * The caller supplies these ONLY when `v2.enabled` is true, so a disabled
   * research engine costs nothing. The engine itself still enforces causality:
   * `closedHtfCandles()` keeps a bar only when `openTime + tfMs(htf)` is at or
   * before the close time of the evaluated LTF bar, so an unclosed higher-
   * timeframe candle can never be consulted. When this is omitted or a needed
   * timeframe is missing, the panel honestly reports UNKNOWN rather than
   * inventing a bias.
   */
  htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>,
): ChartPayload {
  const ev = evaluate({ symbol, timeframe, candles, settings });
  // V2 diagnostics are computed only when the research engine is enabled.
  // It never influences signals — it is an inspection surface.
  const v2Setup = evaluateV2IfEnabled({
    symbol,
    timeframe,
    candles,
    settings,
    ...(htfCandles ? { htfCandles } : {}),
  });

  let boxes: OverlayBox[] = [];
  let lines: OverlayLine[] = [];
  let markers: OverlayMarker[] = [];

  if (ev) {
    // --- rule 1: one event per dedupeKey, strongest wins ---
    const strongest = new Map<string, (typeof ev.events)[number]>();
    for (const e of ev.events) {
      const prev = strongest.get(e.dedupeKey);
      if (!prev || e.strength > prev.strength) strongest.set(e.dedupeKey, e);
    }
    const events = [...strongest.values()];

    const rawMarkers: Array<OverlayMarker & { strength: number }> = [];

    for (const e of events) {
      const id = `${e.detector}-${e.dedupeKey}`;
      if (e.zone) {
        boxes.push({
          id,
          detector: e.detector,
          direction: e.direction,
          from: e.zone.from,
          to: e.zone.to,
          priceLow: e.zone.priceLow,
          priceHigh: e.zone.priceHigh,
          label: detectorShortLabel(e.detector),
          reason: e.reason,
          strength: e.strength,
        });
      }
      if (e.line) {
        lines.push({
          id,
          detector: e.detector,
          direction: e.direction,
          from: e.line.from,
          to: e.line.to,
          price: e.line.price,
          label: detectorShortLabel(e.detector),
          reason: e.reason,
          strength: e.strength,
        });
      }
      if (MARKER_FACTORS.includes(e.detector)) {
        rawMarkers.push({
          time: e.time,
          position: e.direction === 'LONG' ? 'belowBar' : 'aboveBar',
          shape: e.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
          color: detectorColor(e.detector),
          text: detectorShortLabel(e.detector),
          detector: e.detector,
          strength: e.strength,
        });
      }
    }

    // --- rules 2 + 4: caps, strongest first ---
    boxes = capPerFactor(boxes, MAX_BOXES_PER_FACTOR, MAX_BOXES_TOTAL);
    lines = capPerFactor(lines, MAX_LINES_TOTAL, MAX_LINES_TOTAL);
    const capped = capPerFactor(rawMarkers, MAX_MARKERS_PER_FACTOR, MAX_MARKERS_TOTAL);

    // --- rule 3: collapse markers sharing a bar AND a side ---
    const grouped = new Map<string, OverlayMarker & { strength: number }>();
    for (const m of capped) {
      const key = `${m.time}:${m.position}`;
      const prev = grouped.get(key);
      if (!prev) {
        grouped.set(key, { ...m, groupCount: 1 });
        continue;
      }
      // Merge: keep the strongest marker's colour/shape, combine the labels.
      const labels = new Set(prev.text.split('+').concat(m.text.split('+')));
      const merged =
        m.strength > prev.strength ? { ...m, groupCount: 0 } : { ...prev, groupCount: 0 };
      merged.text = [...labels].join('+');
      merged.groupCount = (prev.groupCount ?? 1) + 1;
      grouped.set(key, merged);
    }

    markers = [...grouped.values()]
      .sort((a, b) => a.time - b.time)
      .map(({ strength: _s, ...m }) => m);
  }

  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);

  // Legend lists only the factors actually drawn.
  const present = new Set<FactorId>();
  for (const b of boxes) present.add(b.detector);
  for (const l of lines) present.add(l.detector);
  for (const m of markers) present.add(m.detector);
  const legend = [...present].sort().map((d) => ({
    detector: d,
    label: FACTOR_LABEL[d],
    color: detectorColor(d),
    kind: String(d),
  }));

  return {
    symbol,
    timeframe,
    tickSize: tickSize ?? null,
    candles: sorted.map((c) => ({
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      isClosed: c.isClosed,
    })),
    overlays: { boxes, lines, markers, legend },
    v2: v2Setup ? buildV2Diagnostics(v2Setup) : null,
    evaluation: ev
      ? {
          candleTime: ev.candleTime,
          closePrice: ev.closePrice,
          atr: ev.atr,
          long: ev.long,
          short: ev.short,
          longScore: ev.longScore,
          shortScore: ev.shortScore,
          confirmations: ev.confirmations,
          decision: ev.decision,
          explainLong: explain(ev.long),
          explainShort: explain(ev.short),
        }
      : null,
    signal: signal ?? null,
    closedCount: sorted.filter((c) => c.isClosed).length,
  };
}

/** Build the entry/SL/TP level set for a persisted signal. */
export function buildSignalLevels(row: {
  entry_price: number | null;
  stop_loss: number | null;
  take_profits: unknown;
}): SignalLevel[] {
  const levels: SignalLevel[] = [];
  if (row.entry_price !== null && Number.isFinite(row.entry_price)) {
    levels.push({ kind: 'ENTRY', price: row.entry_price, label: 'ENTRY', color: '#e2e8f0' });
  }
  if (row.stop_loss !== null && Number.isFinite(row.stop_loss)) {
    levels.push({ kind: 'SL', price: row.stop_loss, label: 'SL', color: '#ef4444' });
  }
  const tps = Array.isArray(row.take_profits) ? (row.take_profits as number[]) : [];
  const tpKinds: Array<SignalLevel['kind']> = ['TP1', 'TP2', 'TP3'];
  tps.slice(0, 3).forEach((p, i) => {
    if (!Number.isFinite(p)) return;
    const kind = tpKinds[i];
    if (!kind) return;
    levels.push({ kind, price: p, label: kind, color: '#22c55e' });
  });
  return levels;
}
