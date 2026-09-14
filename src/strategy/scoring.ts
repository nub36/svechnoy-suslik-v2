/**
 * Transparent scoring with anti-double-counting.
 *
 * Arithmetic contract (asserted by tests/scoring.test.ts):
 *   contribution_i = strength_i * weight_i          (only for counted events)
 *   rawScore       = Σ contribution_i
 *   totalWeight    = Σ weight_i                     (only for counted events)
 *   score          = 100 * rawScore / totalWeight   (0 when totalWeight == 0)
 *
 * Because strength ∈ [0,1], score ∈ [0,100] by construction.
 *
 * Anti-double-counting rules:
 *  1. Two events with the same `dedupeKey` are the SAME market fact — only the
 *     strongest is counted.
 *  2. A detector may contribute AT MOST ONCE per direction per evaluation, so
 *     e.g. five FVGs cannot stack five weights. The strongest wins.
 * Skipped components are still RETURNED (counted=false + skippedReason) so the
 * breakdown stays fully transparent.
 */

import type {
  DetectorEvent,
  Direction,
  ScoreBreakdown,
  ScoreComponent,
} from '../core/types';
import type { Settings } from '../core/settings';

export function scoreDirection(
  events: readonly DetectorEvent[],
  direction: Direction,
  settings: Settings,
): ScoreBreakdown {
  const mine = events.filter((e) => e.direction === direction);

  // Sort strongest first so the "winner" of each dedupe group is deterministic.
  const sorted = [...mine].sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.time !== a.time) return b.time - a.time;
    return a.dedupeKey.localeCompare(b.dedupeKey);
  });

  const seenKeys = new Set<string>();
  const seenDetectors = new Set<string>();
  const components: ScoreComponent[] = [];
  let duplicatesRemoved = 0;

  for (const e of sorted) {
    const weight = settings.detectorWeight(e.detector);
    const base: Omit<ScoreComponent, 'counted' | 'skippedReason' | 'contribution'> = {
      detector: e.detector,
      direction: e.direction,
      strength: e.strength,
      weight,
      dedupeKey: e.dedupeKey,
      time: e.time,
      reason: e.reason,
    };

    if (seenKeys.has(e.dedupeKey)) {
      duplicatesRemoved++;
      components.push({
        ...base,
        contribution: 0,
        counted: false,
        skippedReason: 'duplicate market fact (same dedupeKey)',
      });
      continue;
    }
    if (seenDetectors.has(e.detector)) {
      duplicatesRemoved++;
      components.push({
        ...base,
        contribution: 0,
        counted: false,
        skippedReason: 'detector already counted this evaluation (strongest kept)',
      });
      seenKeys.add(e.dedupeKey);
      continue;
    }
    if (weight <= 0) {
      components.push({
        ...base,
        contribution: 0,
        counted: false,
        skippedReason: 'weight is zero',
      });
      seenKeys.add(e.dedupeKey);
      continue;
    }

    seenKeys.add(e.dedupeKey);
    seenDetectors.add(e.detector);
    components.push({
      ...base,
      contribution: e.strength * weight,
      counted: true,
    });
  }

  const counted = components.filter((c) => c.counted);
  const rawScore = counted.reduce((s, c) => s + c.contribution, 0);
  const totalWeight = counted.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0 ? (100 * rawScore) / totalWeight : 0;

  // Keep the breakdown readable: counted first, then skipped, by time desc.
  components.sort((a, b) => {
    if (a.counted !== b.counted) return a.counted ? -1 : 1;
    return b.contribution - a.contribution || b.time - a.time;
  });

  return {
    direction,
    rawScore: round(rawScore, 6),
    totalWeight: round(totalWeight, 6),
    score: round(score, 4),
    components,
    duplicatesRemoved,
  };
}

/** Number of distinct detectors that actually contributed. */
export function countedDetectors(b: ScoreBreakdown): number {
  return new Set(b.components.filter((c) => c.counted).map((c) => c.detector)).size;
}

export function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Human-readable breakdown, used by the UI and the CLI. */
export function explain(b: ScoreBreakdown): string[] {
  const lines: string[] = [];
  lines.push(
    `${b.direction}: score=${b.score.toFixed(2)} (raw=${b.rawScore.toFixed(3)} / weight=${b.totalWeight.toFixed(1)})`,
  );
  for (const c of b.components) {
    if (c.counted) {
      lines.push(
        `  + ${c.detector.padEnd(17)} strength=${c.strength.toFixed(3)} x weight=${c.weight} = ${c.contribution.toFixed(3)}  | ${c.reason}`,
      );
    } else {
      lines.push(`  - ${c.detector.padEnd(17)} SKIPPED (${c.skippedReason})  | ${c.reason}`);
    }
  }
  if (b.duplicatesRemoved > 0) {
    lines.push(`  (${b.duplicatesRemoved} duplicate component(s) removed by anti-double-counting)`);
  }
  return lines;
}
