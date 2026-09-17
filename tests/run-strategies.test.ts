/**
 * The portfolio runner is the entry point an operator is told to use, so its
 * registry must not drift away from the modules and artifacts it claims to drive.
 * These tests check the claims that would matter if they silently broke:
 *
 *  - the module hashes it pins are the real hashes;
 *  - the published artifacts it compares against still exist;
 *  - the module files it runs exist and export something the CLI can execute;
 *  - the committed comparison report matches the committed artifacts, so the
 *    "no drift" claim cannot be left stale in the repository;
 *  - no strategy is described as validated, live or production-ready unless the
 *    status string says which evidence exists.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const sha = (p: string): string => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');
const json = <T>(p: string): T => JSON.parse(read(p)) as T;

const RUNNER = 'scripts/run-strategies.ts';
const DOC = 'docs/HOW_TO_RUN_STRATEGIES.md';

/** Registry rows, parsed straight out of the source so the test cannot drift. */
const registry = (): { id: string; module: string; published: string; status: string; sha256Prefix: string }[] => {
  const src = read(RUNNER);
  const body = src.slice(src.indexOf('const STRATEGIES: StrategyRun[] = ['), src.indexOf('/* ---------------', src.indexOf('const STRATEGIES')));
  return [...body.matchAll(/id: '(\w+)'[\s\S]*?module: '([^']+)'[\s\S]*?sha256Prefix: '([^']*)'[\s\S]*?published: '([^']+)'[\s\S]*?status: '([^']+)'/g)]
    .map((m) => ({ id: m[1]!, module: m[2]!, sha256Prefix: m[3]!, published: m[4]!, status: m[5]! }));
};

describe('portfolio runner — scripts/run-strategies.ts', () => {
  it('lists every strategy that has a research module', () => {
    const ids = registry().map((r) => r.id);
    expect(ids).toContain('v30');
    expect(ids).toContain('v33');
    expect(ids).toContain('v28');
    expect(ids).toContain('v31');
    expect(ids).toContain('v32');
  });

  it('every registry row points at a module and a published artifact that exist', () => {
    for (const row of registry()) {
      expect(existsSync(join(root, row.module)), `${row.id}: missing module ${row.module}`).toBe(true);
      expect(existsSync(join(root, row.published)), `${row.id}: missing artifact ${row.published}`).toBe(true);
    }
  });

  it('the pinned hashes are the real hashes of the frozen modules', () => {
    for (const row of registry()) {
      if (!row.sha256Prefix) continue; // only V3.0 and V3.3 are hash-frozen
      expect(sha(row.module).startsWith(row.sha256Prefix), `${row.id}: ${row.module} hash moved`).toBe(true);
    }
    // and they are the hashes the other tests pin, verbatim
    expect(sha('research/v30_htf_trap.ts').startsWith('a821757f')).toBe(true);
    expect(sha('research/v33_zone_mitigation.ts')).toBe(
      '3f5b1478a1b0c240a85b28a0280d61761246091ca0ed122fab2e03113fe2b1c6');
  });

  it('the status of every row names its evidence honestly', () => {
    const byId = Object.fromEntries(registry().map((r) => [r.id, r.status]));

    // the only strategy allowed to claim validation is the one that has it
    expect(byId.v30).toBe('V3_0_VALIDATED_FOR_RESEARCH');
    expect(byId.v28).toContain('ZERO FEES ONLY');
    expect(byId.v33).toBe('V3_3_TRAIN_ONLY');
    // the falsified pair says so
    expect(byId.v31).toContain('FALSIFIED');
    expect(byId.v32).toContain('FALSIFIED');

    // and nothing anywhere is sold as production ready or live
    const src = read(RUNNER);
    expect(src).toMatch(/PRODUCTION_READY is[\s\S]{0,40}forbidden/i);
    expect(src).toContain('nothing here trades, places an order, or talks to an exchange');
    // every mention of the label sits next to the prohibition
    for (const m of src.matchAll(/PRODUCTION_READY/g)) {
      expect(src.slice(m.index!, m.index! + 160)).toContain('forbidden');
    }
  });

  it('the committed comparison report matches the committed artifacts', () => {
    const report = json<{
      scope: string;
      fees: { makerBps: number; takerBps: number };
      strategies: { id: string; moduleSha256Prefix: string; metrics: { n: number; grossRPerTrade: number; netRPerTrade: Record<string, number> | null } }[];
      problems: unknown[];
    }>('artifacts/research/portfolio-comparison.json');

    expect(report.scope).toContain('TRAIN');
    expect(report.fees).toMatchObject({ makerBps: 2, takerBps: 5 });
    expect(report.problems).toEqual([]);

    const ids = report.strategies.map((s) => s.id).sort();
    expect(ids).toEqual(['v28', 'v30', 'v31', 'v32', 'v33']);

    for (const s of report.strategies) {
      // the hash recorded in the report is the module's current hash
      expect(sha(registry().find((r) => r.id === s.id)!.module).startsWith(s.moduleSha256Prefix)).toBe(true);

      // and every figure equals the committed artifact's figure
      const published = json<Record<string, unknown>>(registry().find((r) => r.id === s.id)!.published);
      if (s.id === 'v28') {
        const trail = (published.arms as { arm: string; n: number; grossRPerTrade: number }[]).find((a) => a.arm === 'Trail')!;
        expect(s.metrics.n).toBe(trail.n);
        expect(s.metrics.grossRPerTrade).toBeCloseTo(trail.grossRPerTrade, 10);
      } else {
        expect(s.metrics.n).toBe(published.n);
        expect(s.metrics.grossRPerTrade).toBeCloseTo(published.grossRPerTrade as number, 10);
        expect(s.metrics.netRPerTrade!.FUT_4).toBeCloseTo((published.netRPerTrade as Record<string, number>).FUT_4!, 10);
      }
    }
  });

  it('the operator document quotes the same figures and the same caveats', () => {
    const doc = read(DOC);
    const report = json<{ strategies: { id: string; metrics: { netRPerTrade: Record<string, number> | null; grossRPerTrade: number } }[] }>(
      'artifacts/research/portfolio-comparison.json');

    // net figures appear with the sign the artifacts carry
    expect(doc).toContain('+0.0994');
    expect(doc).toContain('+0.0267');
    expect(doc).toContain('+0.0600');
    expect(doc).toContain('+0.1462');

    // the three corrections the operator must not miss
    expect(doc).toContain('сделка разворота');               // V3.3 is a reversal, not continuation
    expect(doc).toContain('ex-top-1 % +0.0264 < комиссия 0.0511');
    expect(doc).toContain('−0.0143');                         // V2.8 validation is tail-dependent too
    expect(doc).toMatch(/ZERO\*|нулевых комиссиях/);

    // and the safety line
    expect(doc).toContain('LIVE_TRADING_ENABLED = false');
    expect(doc).toContain('PRODUCTION_READY');

    expect(report.strategies.length).toBe(5);
  });

  it('the cache caveat that cost trades is recorded, not silently fixed', () => {
    // 315 vs 317 trades: the 1h rows need 1d context. The runner prints the warning.
    const src = read(RUNNER);
    expect(src).toContain('315');
    expect(src).toContain('317');
    expect(src).toContain('1d');
  });
});
