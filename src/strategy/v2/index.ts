/**
 * SMC V2 — public surface.
 *
 * V2 is a RESEARCH engine. It is not wired into the production signal path and
 * it never submits orders. `v2.enabled` gates whether anything may consume it;
 * activation is a separate, evidence-gated decision documented in
 * docs/STRATEGY.md.
 */

import type { Settings } from '../../core/settings';
import type { V2EvaluateArgs, V2Setup } from './types';
import { evaluateV2 } from './engine';

export * from './types';
export { evaluateV2, paramsFromSettings, aggregateEvidence, COMPONENT_WEIGHTS } from './engine';
export * from './indicators';
export * from './structure';
export * from './htf';

/** Is the V2 research engine switched on? Read from the settings registry. */
export function v2Enabled(settings: Settings): boolean {
  try {
    return settings.bool('v2.enabled');
  } catch {
    return false;
  }
}

/**
 * Evaluate with V2 only when it is enabled. Returns null when disabled, so a
 * caller can never accidentally act on a disabled research engine.
 */
export function evaluateV2IfEnabled(args: V2EvaluateArgs): V2Setup | null {
  if (!v2Enabled(args.settings)) return null;
  return evaluateV2(args);
}
