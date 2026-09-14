/**
 * SMC V2 — the setup engine.
 *
 * Answers ONE question at every closed bar:
 *
 *   Price has reached a significant range edge. Is the market confirming
 *   (A) REVERSAL — liquidity swept, reclaimed, structure turning, or
 *   (B) CONTINUATION — genuine acceptance beyond the level, or
 *   (C) neither, in which case the answer is WAIT?
 *
 * Explicitly NOT implemented, by design:
 *   reached HIGH -> SHORT,  reached LOW -> LONG.
 * A range edge is a place to LOOK, never a signal by itself.
 *
 * WAIT is a first-class outcome. When evidence is insufficient the engine says
 * so and records why, instead of manufacturing a direction.
 */

import type { Candle, Direction } from '../../core/types';
import type { Settings } from '../../core/settings';
import {
  buildAdxContext, buildAtrContext, buildEmaContext, buildMacdContext,
  buildRsiContext, buildVolumeContext,
} from './indicators';
import {
  buildFib, buildOrderBlock, buildRange, detectBreakout, detectDisplacement,
  detectStructureBreak, detectSweep, findFvg, findLiquidityPools, findSwingsV2,
  rangeLocation, structureBias,
} from './structure';
import { buildHtfContexts, htfAlignment, htfScore } from './htf';
import type {
  ComponentProfile, FairValueGap, OrderBlock, RoomToTarget, SetupKind,
  SetupPhase, StructuralStop, TargetPlan, V2Direction, V2EvaluateArgs, V2Range,
  V2Setup,
} from './types';
import { COMPONENT_KEYS, emptyProfile } from './types';

const clamp01 = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

export interface V2Params {
  swingStrength: number;
  lookback: number;
  rangeEdgePct: number;
  minRangeConfidence: number;
  sweepMinPenetrationAtr: number;
  sweepMinWickRatio: number;
  sweepReclaimWindow: number;
  breakoutMinCloseAtr: number;
  breakoutMinBodyAtr: number;
  breakoutHoldWindow: number;
  displacementMinBodyAtr: number;
  structureMinPenetrationAtr: number;
  fvgMinSizeAtr: number;
  liquidityTolAtr: number;
  minEvidence: number;
  minNetEvidence: number;
  minRoomR: number;
  minFirstTargetR: number;
  stopBufferAtr: number;
  rsiPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  volumePeriod: number;
}

/** Read V2 parameters from the settings registry — the single source of truth. */
export function paramsFromSettings(s: Settings): V2Params {
  const n = (k: string, d: number): number => {
    try {
      const v = s.num(k);
      return Number.isFinite(v) ? v : d;
    } catch {
      return d;
    }
  };
  return {
    swingStrength: Math.floor(n('engine.swing_lookback', 3)),
    lookback: Math.floor(n('engine.lookback_candles', 300)),
    rangeEdgePct: n('v2.range_edge_pct', 0.25),
    minRangeConfidence: n('v2.min_range_confidence', 0.25),
    sweepMinPenetrationAtr: n('v2.sweep_min_penetration_atr', 0.1),
    sweepMinWickRatio: n('v2.sweep_min_wick_ratio', 0.25),
    sweepReclaimWindow: Math.floor(n('v2.sweep_reclaim_window', 3)),
    breakoutMinCloseAtr: n('v2.breakout_min_close_atr', 0.25),
    breakoutMinBodyAtr: n('v2.breakout_min_body_atr', 0.5),
    breakoutHoldWindow: Math.floor(n('v2.breakout_hold_window', 3)),
    displacementMinBodyAtr: n('v2.displacement_min_body_atr', 0.6),
    structureMinPenetrationAtr: n('v2.structure_min_penetration_atr', 0.05),
    fvgMinSizeAtr: n('v2.fvg_min_size_atr', 0.15),
    liquidityTolAtr: n('v2.liquidity_tol_atr', 0.25),
    minEvidence: n('v2.min_evidence', 0.45),
    minNetEvidence: n('v2.min_net_evidence', 0.12),
    minRoomR: n('v2.min_room_r', 1.5),
    minFirstTargetR: n('v2.min_first_target_r', 0.5),
    stopBufferAtr: n('v2.stop_buffer_atr', 0.25),
    rsiPeriod: Math.floor(n('v2.rsi_period', 14)),
    atrPeriod: Math.floor(n('risk.atr_period', 14)),
    adxPeriod: Math.floor(n('v2.adx_period', 14)),
    volumePeriod: Math.floor(n('v2.volume_period', 20)),
  };
}

/* ------------------------------------------------------------------ */
/* Evidence aggregation                                                */
/* ------------------------------------------------------------------ */

/**
 * Component weights. These are deliberately EQUAL-ish and were NOT hand-tuned
 * to make any particular example look good — §5/§24 of the spec require the
 * features to be measurable first and weighted only once statistics exist.
 */
export const COMPONENT_WEIGHTS: Readonly<Record<keyof ComponentProfile, number>> = {
  structure: 1.4,
  liquidity: 1.4,
  displacement: 1.1,
  obFvg: 0.9,
  volume: 0.8,
  htf: 1.0,
  trend: 0.8,
  momentum: 0.8,
  volatility: 0.5,
  roomToTarget: 1.1,
};

export function aggregateEvidence(p: ComponentProfile): number {
  let sum = 0;
  let wsum = 0;
  for (const k of COMPONENT_KEYS) {
    const w = COMPONENT_WEIGHTS[k];
    sum += clamp01(p[k]) * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : 0;
}

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Targets are STRUCTURAL, not arbitrary R multiples, and — crucially — they are
 * the NEXT levels the move must actually pass through:
 *
 *   TP1 nearest internal liquidity ahead of entry
 *   TP2 the next structural level after TP1. Equilibrium qualifies ONLY when it
 *       really is the next level; if other liquidity sits between entry and the
 *       50% line, that liquidity is the next target, not equilibrium.
 *   TP3 the next structural level after TP2 — opposite range edge / external
 *       liquidity, but only while the range is still valid on that side.
 *
 * Two rules keep the ladder honest, and both are structural rather than a
 * cosmetic R cap:
 *
 *  1. RANGE INVALIDATION. Once price has accepted beyond a boundary, the range
 *     is stale on that side and its opposite edge is no longer a level this
 *     move is travelling toward. A continuation trade that just broke out does
 *     not aim back across the whole old range.
 *
 *  2. NEXT-LEVEL ORDERING. Every rung must be the nearest remaining structural
 *     level beyond the previous rung. That is what stops TP2 skipping a dozen
 *     liquidity pools to land on equilibrium 25R away.
 *
 * If structure genuinely supplies nothing, we fall back to R multiples and say
 * so in `basis`/`reason`. The fallback multiples are fixed (1R/2R/3R) and were
 * NOT fitted to any slice.
 */
export function buildTargets(
  direction: Direction,
  entry: number,
  stop: number,
  range: V2Range | null,
  pools: readonly { side: 'BUY_SIDE' | 'SELL_SIDE'; price: number }[],
  atr: number | null,
): TargetPlan[] {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return [];

  const rOf = (p: number): number =>
    (direction === 'LONG' ? p - entry : entry - p) / risk;
  const atrOf = (p: number): number => {
    if (!atr || atr <= 0) return 0;
    return (direction === 'LONG' ? p - entry : entry - p) / atr;
  };
  /** Strictly beyond entry, in the direction of the trade. */
  const ahead = (p: number): boolean =>
    direction === 'LONG' ? p > entry : p < entry;

  /* ---- collect every structurally valid CANDIDATE ahead of entry ---- */
  interface Candidate {
    price: number;
    basis: TargetPlan['basis'];
    reason: string;
  }
  const candidates: Candidate[] = [];

  // Internal liquidity on the side we are travelling toward.
  const wantSide = direction === 'LONG' ? 'BUY_SIDE' : 'SELL_SIDE';
  for (const p of pools) {
    if (p.side !== wantSide) continue;
    if (!ahead(p.price)) continue;
    candidates.push({
      price: p.price,
      basis: 'INTERNAL_LIQUIDITY',
      reason: 'Resting liquidity in the direction of travel',
    });
  }

  if (range) {
    // Equilibrium is a candidate only when it lies AHEAD of entry. Behind
    // entry, already passed, or on the wrong side => not a target at all.
    if (ahead(range.mid)) {
      candidates.push({
        price: range.mid,
        basis: 'EQUILIBRIUM',
        reason: 'Range equilibrium (50% of the range)',
      });
    }

    // The opposite edge is a candidate only while the range is still VALID on
    // the side we would be aiming at. If price has already accepted beyond a
    // boundary, the old container is stale and its far edge is not the level
    // this move is heading for.
    const far = direction === 'LONG' ? range.high : range.low;
    const farSide: 'HIGH' | 'LOW' = direction === 'LONG' ? 'HIGH' : 'LOW';
    const rangeStale = range.brokenSide !== null;
    if (ahead(far) && !rangeStale) {
      candidates.push({
        price: far,
        basis: 'RANGE_EDGE',
        reason: `Opposite side of the range (${farSide}) — external liquidity`,
      });
    }
  }

  /* ---- order by distance, de-duplicate, keep only NEXT levels ---- */
  candidates.sort((a, b) =>
    direction === 'LONG' ? a.price - b.price : b.price - a.price);

  // Near-duplicate collapsing: two levels within 0.15 ATR (or 0.05% of price
  // when ATR is unusable) are the same structural level in practice.
  const nearTol = atr && atr > 0 ? atr * 0.15 : Math.abs(entry) * 0.0005;

  const out: TargetPlan[] = [];
  for (const c of candidates) {
    if (out.length >= 3) break;
    const r = rOf(c.price);
    if (!(r > 0)) continue; // must be ahead of entry
    const prev = out[out.length - 1];
    if (prev && Math.abs(c.price - prev.price) <= nearTol) continue; // duplicate
    out.push({
      price: c.price,
      basis: c.basis,
      reason: c.reason,
      r,
      atrDistance: atrOf(c.price),
    });
  }

  // Fall back to R multiples ONLY where structure gave us nothing at all.
  const fallback = [1, 2, 3];
  while (out.length < 3) {
    const r = fallback[out.length] ?? out.length + 1;
    const p = direction === 'LONG' ? entry + risk * r : entry - risk * r;
    const prev = out[out.length - 1];
    // Never emit a fallback that sits behind a structural rung we already have.
    if (prev && ((direction === 'LONG' && p <= prev.price) || (direction === 'SHORT' && p >= prev.price))) {
      break;
    }
    out.push({
      price: p,
      basis: 'R_MULTIPLE',
      reason: `No structural level available; ${r}R fallback`,
      r,
      atrDistance: atrOf(p),
    });
  }

  // Final guarantee: strictly increasing R, no duplicates, at most 3 rungs.
  const seen = new Set<number>();
  return out
    .filter((t) => {
      const k = Math.round(t.price * 1e8);
      if (seen.has(k)) return false;
      seen.add(k);
      return t.r > 0;
    })
    .sort((a, b) => a.r - b.r)
    .slice(0, 3);
}

/**
 * Room assessment. A trade is NOT acceptable merely because a distant final
 * target produces a large `finalR`: the nearest structural target must itself
 * leave workable room, otherwise the ladder is "TP1 at 0.2R then a 50R moon
 * shot", which is exactly the pathology the audit found.
 */
export function assessRoom(
  targets: readonly TargetPlan[],
  entry: number,
  atr: number | null,
  minRoomR: number,
  minFirstR: number,
): RoomToTarget {
  void entry;
  if (targets.length === 0) {
    return {
      finalR: 0, firstR: 0, nextStructuralR: 0, atrDistance: 0,
      firstAtrDistance: 0, adequate: false,
      reason: 'No reachable target could be derived',
    };
  }
  const last = targets[targets.length - 1]!;
  const first = targets[0]!;
  const finalR = last.r;
  const firstR = first.r;
  const nextStructuralR = (targets[1] ?? last).r;

  const finalOk = finalR >= minRoomR;
  const firstOk = firstR >= minFirstR;
  const adequate = finalOk && firstOk;

  let reason: string;
  if (!finalOk) {
    reason = `Only ${finalR.toFixed(2)}R to the final target, below the ${minRoomR}R floor`;
  } else if (!firstOk) {
    reason =
      `First target is only ${firstR.toFixed(2)}R away (floor ${minFirstR}R) — ` +
      `the nearest structural level leaves too little room, even though the final target is ${finalR.toFixed(2)}R`;
  } else {
    reason =
      `First target ${firstR.toFixed(2)}R, next ${nextStructuralR.toFixed(2)}R, ` +
      `final ${finalR.toFixed(2)}R`;
  }

  return {
    finalR,
    firstR,
    nextStructuralR,
    // REAL directional distance, not abs(price)/ATR.
    atrDistance: last.atrDistance,
    firstAtrDistance: first.atrDistance,
    adequate,
    reason,
  };
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export function evaluateV2(args: V2EvaluateArgs): V2Setup | null {
  const { symbol, timeframe, settings } = args;
  const p = paramsFromSettings(settings);

  const closed = args.candles.filter((c) => c.isClosed);
  const evalIndex = args.atIndex ?? closed.length - 1;
  if (evalIndex < 0 || evalIndex >= closed.length) return null;

  // Only bars up to and including N are visible. This slice IS the guarantee.
  const visible = closed.slice(0, evalIndex + 1);
  const windowStart = Math.max(0, visible.length - p.lookback);
  const window = visible.slice(windowStart);
  const i = window.length - 1;

  const minBars = Math.max(60, p.swingStrength * 6 + 30);
  if (window.length < minBars) return null;

  const bar = window[i]!;

  /* --- indicator layer --- */
  const atrCtx = buildAtrContext(window, i, p.atrPeriod);
  const atr = atrCtx.atr;
  const volCtx = buildVolumeContext(window, i, p.volumePeriod);
  const emaCtx = buildEmaContext(window, i, atr);
  const macdCtx = buildMacdContext(window, i);
  const rsiCtx = buildRsiContext(window, i, p.rsiPeriod);
  const adxCtx = buildAdxContext(window, i, p.adxPeriod);

  /* --- structure layer --- */
  const swings = findSwingsV2(window, p.swingStrength);
  const bias = structureBias(swings, i);
  const range = buildRange(window, swings, i, atr, p.lookback, timeframe);
  const location = rangeLocation(range, p.rangeEdgePct);
  const fib = buildFib(range, bar.close);
  const pools = findLiquidityPools(swings, i, atr, p.liquidityTolAtr, p.lookback);

  const structBreak = detectStructureBreak(
    window, swings, i, atr, p.structureMinPenetrationAtr,
  );
  const displacement = detectDisplacement(
    window, i, atr, volCtx.rvol, p.displacementMinBodyAtr,
  );
  const sweep = detectSweep(window, pools, i, atr, volCtx.rvol, {
    minPenetrationAtr: p.sweepMinPenetrationAtr,
    minWickRatio: p.sweepMinWickRatio,
    reclaimWindow: p.sweepReclaimWindow,
  });
  const breakout = detectBreakout(window, pools, i, atr, volCtx.rvol, {
    minCloseBeyondAtr: p.breakoutMinCloseAtr,
    minBodyAtr: p.breakoutMinBodyAtr,
    holdWindow: p.breakoutHoldWindow,
  });

  /* --- HTF --- */
  const barCloseTime = bar.closeTime;
  const htf = buildHtfContexts(timeframe, args.htfCandles, barCloseTime, p.swingStrength);

  /* --- OB / FVG --- */
  let orderBlock: OrderBlock | null = null;
  if (displacement) {
    const origin = structBreak && !structBreak.wickOnly
      ? (structBreak.type === 'BOS' ? 'BOS' : 'CHOCH')
      : sweep ? 'SWEEP_REACTION' : null;
    if (origin) {
      orderBlock = buildOrderBlock(window, displacement, origin, i, timeframe);
    }
  }
  let fvg: FairValueGap | null = null;
  for (let k = i - 1; k >= Math.max(1, i - 10); k--) {
    const g = findFvg(window, k, atr, i, timeframe, p.fvgMinSizeAtr);
    if (g && g.state !== 'FILLED') {
      fvg = g;
      break;
    }
  }

  /* --- candidate classification --- */
  const reasons: string[] = [];
  const waitReasons: string[] = [];

  let direction: V2Direction = 'WAIT';
  let kind: SetupKind | null = null;
  let phase: SetupPhase = 'SCANNING';

  const atEdge = location === 'HIGH' || location === 'LOW';
  if (!range) {
    waitReasons.push('Нет подтверждённого диапазона: недостаточно структурных свингов.');
  } else if (range.confidence < p.minRangeConfidence) {
    waitReasons.push(
      `Диапазон слишком слабый (confidence ${range.confidence.toFixed(2)} < ${p.minRangeConfidence}).`,
    );
  }

  if (range && atEdge) phase = 'AT_LIQUIDITY';
  else if (range && Math.abs(range.position - 0.5) > 0.2) phase = 'APPROACHING_LEVEL';

  // A breakout that is holding INVALIDATES the opposing reversal idea.
  const breakoutValid = breakout !== null && breakout.held && breakout.quality > 0.35;
  const sweepValid = sweep !== null && sweep.reclaimed && sweep.quality > 0.3;

  let candidate: Direction | null = null;

  if (breakoutValid && breakout) {
    candidate = breakout.direction;
    kind = 'CONTINUATION';
    phase = 'BREAKOUT_DETECTED';
    reasons.push(breakout.reason);
  } else if (sweepValid && sweep) {
    candidate = sweep.direction;
    kind = 'REVERSAL';
    phase = 'SWEEP_DETECTED';
    reasons.push(sweep.reason);
  } else if (range && atEdge) {
    waitReasons.push(
      location === 'HIGH'
        ? 'Цена у верхней границы диапазона, но нет ни подтверждённого снятия ликвидности с возвратом, ни принятия выше уровня.'
        : 'Цена у нижней границы диапазона, но нет ни подтверждённого снятия ликвидности с возвратом, ни принятия ниже уровня.',
    );
  } else {
    waitReasons.push('Цена в середине диапазона — нет точки наблюдения у границы.');
  }

  /* --- component profile --- */
  const longP = emptyProfile();
  const shortP = emptyProfile();

  const fill = (prof: ComponentProfile, dir: Direction): void => {
    // Structure: a confirmed break in our direction is the strongest evidence.
    let structure = 0;
    if (structBreak && !structBreak.wickOnly && structBreak.direction === dir) {
      structure = structBreak.type === 'CHOCH' ? 0.85 : 1;
    } else if (bias === (dir === 'LONG' ? 'BULLISH' : 'BEARISH')) {
      structure = 0.5;
    } else if (bias === 'RANGE') {
      structure = 0.3;
    }
    prof.structure = structure;

    // Liquidity: sweep in our direction, scaled by its measured quality.
    prof.liquidity = sweep && sweep.direction === dir ? sweep.quality
      : breakout && breakout.direction === dir ? breakout.quality * 0.7
      : 0;

    prof.displacement = displacement && displacement.direction === dir
      ? displacement.strength : 0;

    let obFvg = 0;
    if (orderBlock && orderBlock.direction === dir && orderBlock.state !== 'INVALIDATED') {
      obFvg += 0.6;
    }
    if (fvg && fvg.direction === dir && fvg.state !== 'FILLED') obFvg += 0.4;
    prof.obFvg = clamp01(obFvg);

    prof.volume = volCtx.rvol === null ? 0.4 : clamp01((volCtx.rvol - 0.7) / 1.3);

    prof.htf = htfScore(htfAlignment(htf, dir));

    // Trend: EMA alignment as CONTEXT, never as a standalone trigger.
    const want = dir === 'LONG' ? 'BULLISH' : 'BEARISH';
    prof.trend = emaCtx.alignment === want ? 0.9
      : emaCtx.alignment === 'RANGE' ? 0.45 : 0.15;

    // Momentum: MACD + RSI as confirmation only.
    let mom = 0.5;
    if (macdCtx.histogram !== null) {
      const agree = dir === 'LONG' ? macdCtx.histogram > 0 : macdCtx.histogram < 0;
      mom = agree ? 0.7 : 0.3;
      if (agree && macdCtx.accelerating) mom += 0.15;
    }
    if (rsiCtx.rsi !== null) {
      // Overbought/oversold is NOT a reversal trigger; divergence is a mild plus.
      if (dir === 'LONG' && rsiCtx.bullishDivergence) mom += 0.15;
      if (dir === 'SHORT' && rsiCtx.bearishDivergence) mom += 0.15;
      if (dir === 'LONG' && rsiCtx.above50) mom += 0.05;
      if (dir === 'SHORT' && !rsiCtx.above50) mom += 0.05;
    }
    prof.momentum = clamp01(mom);

    // Volatility: avoid dead and berserk markets alike.
    prof.volatility = atrCtx.regime === 'NORMAL' ? 0.8
      : atrCtx.regime === 'HIGH' ? 0.5 : 0.35;

    // roomToTarget is filled in after the stop is known.
    prof.roomToTarget = 0.5;
  };

  fill(longP, 'LONG');
  fill(shortP, 'SHORT');

  /* --- entry / stop / targets for the candidate --- */
  let entry: number | null = null;
  let stop: StructuralStop | null = null;
  let targets: TargetPlan[] = [];
  let room: RoomToTarget | null = null;

  if (candidate && atr !== null && atr > 0) {
    // Baseline reproducible entry = OPEN of N+1. The engine records the close
    // of N; the caller fills the actual entry when bar N+1 exists.
    entry = bar.close;
    const buffer = atr * p.stopBufferAtr;

    if (kind === 'REVERSAL' && sweep) {
      const extreme = candidate === 'LONG'
        ? Math.min(...window.slice(Math.max(0, sweep.index - 1), i + 1).map((c) => c.low))
        : Math.max(...window.slice(Math.max(0, sweep.index - 1), i + 1).map((c) => c.high));
      stop = {
        price: candidate === 'LONG' ? extreme - buffer : extreme + buffer,
        reason: 'Beyond the sweep extreme — if price returns there, the reversal idea is wrong',
        bufferAtr: p.stopBufferAtr,
        anchor: 'SWEEP_EXTREME',
      };
    } else if (kind === 'CONTINUATION' && breakout) {
      stop = {
        price: candidate === 'LONG' ? breakout.level - buffer : breakout.level + buffer,
        reason: 'Back inside the broken level — acceptance failed',
        bufferAtr: p.stopBufferAtr,
        anchor: 'BREAKOUT_LEVEL',
      };
    }

    if (stop) {
      const valid = candidate === 'LONG' ? stop.price < entry : stop.price > entry;
      if (!valid) {
        waitReasons.push('Структурный стоп оказался по неверную сторону от входа.');
        stop = null;
      }
    }

    if (stop) {
      targets = buildTargets(candidate, entry, stop.price, range, pools, atr);
      room = assessRoom(targets, entry, atr, p.minRoomR, p.minFirstTargetR);
      const rScore = clamp01(room.finalR / (p.minRoomR * 2));
      if (candidate === 'LONG') longP.roomToTarget = rScore;
      else shortP.roomToTarget = rScore;
    }
  }

  /* --- evidence, conflict, decision --- */
  const longEvidence = aggregateEvidence(longP);
  const shortEvidence = aggregateEvidence(shortP);
  const conflict = Math.min(longEvidence, shortEvidence);
  const netEvidence = Math.abs(longEvidence - shortEvidence);

  if (candidate) {
    const mine = candidate === 'LONG' ? longEvidence : shortEvidence;
    const other = candidate === 'LONG' ? shortEvidence : longEvidence;

    if (mine < p.minEvidence) {
      waitReasons.push(
        `Совокупные доказательства ${mine.toFixed(2)} ниже порога ${p.minEvidence}.`,
      );
    } else if (mine - other < p.minNetEvidence) {
      waitReasons.push(
        `Конфликт сторон: LONG ${longEvidence.toFixed(2)} против SHORT ${shortEvidence.toFixed(2)} — нет перевеса.`,
      );
    } else if (!stop) {
      waitReasons.push('Не удалось построить структурный стоп.');
    } else if (!room || !room.adequate) {
      waitReasons.push(room?.reason ?? 'Недостаточно места до цели.');
    } else {
      direction = candidate;
      phase = 'READY';
      reasons.push(
        `${kind} ${candidate}: доказательства ${mine.toFixed(2)} против ${other.toFixed(2)}, ` +
        `место до цели ${room.finalR.toFixed(2)}R.`,
      );
    }
  }

  if (direction === 'WAIT' && waitReasons.length === 0) {
    waitReasons.push('Нет достаточных подтверждений для входа.');
  }

  return {
    symbol,
    timeframe,
    index: evalIndex,
    time: bar.openTime,
    close: bar.close,
    direction,
    kind,
    phase,
    location,
    range,
    fib,
    bias,
    sweep,
    breakout,
    structureBreak: structBreak,
    displacement,
    orderBlock,
    fvg,
    ema: emaCtx,
    macd: macdCtx,
    rsi: rsiCtx,
    atr: atrCtx,
    adx: adxCtx,
    vol: volCtx,
    htf,
    htfAlignment: candidate ? htfAlignment(htf, candidate) : 'UNKNOWN',
    longProfile: longP,
    shortProfile: shortP,
    longEvidence,
    shortEvidence,
    conflict,
    netEvidence,
    entry,
    stop,
    targets,
    room,
    reasons,
    waitReasons,
  };
}
