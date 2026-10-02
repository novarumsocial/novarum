// bun benchmarks/compare.ts <baseline.json> <current.json>
// prints a Markdown table (for the job summary) and exits 1 when a scenario's p95 regresses
// by more than BENCH_MAX_REGRESSION (default 0.2 = 20%). BENCH_REPORT_ONLY=1 never fails.
import { z } from 'zod';
import { readResult } from './schema';

const { BENCH_MAX_REGRESSION, BENCH_REPORT_ONLY } = z
  .object({
    BENCH_MAX_REGRESSION: z.coerce.number().positive().default(0.2),
    BENCH_REPORT_ONLY: z.string().optional(),
  })
  .parse(process.env);

const [baselinePath, currentPath] = process.argv.slice(2);
if (!baselinePath || !currentPath) {
  console.error('usage: bun benchmarks/compare.ts <baseline.json> <current.json>');
  process.exit(2);
}
const [baseline, current] = await Promise.all([readResult(baselinePath), readResult(currentPath)]);
const baselineByName = new Map(baseline.results.map((r) => [r.name, r]));

const pct = (from: number, to: number) => (to - from) / from;
const fmt = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
let regressed = 0;
const rows = current.results.map((now) => {
  const before = baselineByName.get(now.name);
  if (!before) return `| ${now.name} | new | ${now.p95Ms.toFixed(2)} | | ${now.opsPerSecond.toFixed(0)} | | |`;
  const p95 = pct(before.p95Ms, now.p95Ms);
  const ops = pct(before.opsPerSecond, now.opsPerSecond);
  const bad = p95 > BENCH_MAX_REGRESSION;
  if (bad) regressed++;
  return `| ${now.name} | ${before.p95Ms.toFixed(2)} | ${now.p95Ms.toFixed(2)} | ${fmt(p95)} | ${now.opsPerSecond.toFixed(0)} | ${fmt(ops)} | ${bad ? 'regressed' : 'ok'} |`;
});

console.log(
  [
    `Baseline \`${baseline.commit}\` vs current \`${current.commit}\` (p95 threshold ${BENCH_MAX_REGRESSION * 100}%)`,
    '',
    '| Scenario | Baseline p95 (ms) | p95 (ms) | p95 change | ops/s | ops/s change | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows,
  ].join('\n')
);
if (regressed && !BENCH_REPORT_ONLY) process.exit(1);
