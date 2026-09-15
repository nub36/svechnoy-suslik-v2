/**
 * Proves the gross-R reconstruction is exact before any figure derived from it
 * is reported.
 *
 * For every closed trade we have entryPrice, stopLoss, exitPrice and the stored
 * net rMultiple. grossR can therefore be computed TWO independent ways:
 *
 *   (a) from prices:  (LONG ? exit-entry : entry-exit) / |entry-stop|
 *   (b) from the identity: storedNetR + feeR
 *
 * If (a) and (b) agree to within the tracker's 6-decimal rounding, the
 * decomposition is arithmetically exact and not an estimate.
 */

import { streamTrades } from './audit-fee-readonly';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

async function main(): Promise<void> {
  const file = arg('file');
  const label = arg('label');
  let n = 0, bad = 0, maxDiff = 0, openSkipped = 0, noExit = 0;

  for await (const t of streamTrades(file)) {
    if (t.result === 'OPEN') { openSkipped++; continue; }
    if (t.exitPrice === null) { noExit++; continue; }
    const fromPrices = (t.direction === 'LONG'
      ? t.exitPrice - t.entryPrice
      : t.entryPrice - t.exitPrice) / t.riskPerUnit;
    const diff = Math.abs(fromPrices - t.grossR);
    if (diff > maxDiff) maxDiff = diff;
    if (diff > 1e-5) bad++;
    n++;
  }

  console.log(`${label}: checked ${n.toLocaleString('en-US')} closed trades`);
  console.log(`  OPEN skipped          : ${openSkipped}`);
  console.log(`  closed without exit   : ${noExit}`);
  console.log(`  max |priceGross - (net+fee)| : ${maxDiff.toExponential(3)}`);
  console.log(`  mismatches > 1e-5     : ${bad}`);
  console.log(`  VERDICT: ${bad === 0 ? 'IDENTITY EXACT' : 'IDENTITY VIOLATED'}`);
}

void main();
