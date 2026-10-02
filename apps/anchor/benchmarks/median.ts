// bun benchmarks/median.ts <out.json> <run1.json> <run2.json> ...
// keeps the median of every metric per scenario, so one noisy CI run doesn't decide the gate
import { readResult } from './schema';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: bun benchmarks/median.ts <out.json> <run.json>...');
  process.exit(2);
}
const runs = await Promise.all(inputs.map(readResult));
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const [first] = runs as [(typeof runs)[number], ...typeof runs];
await Bun.write(
  out,
  `${JSON.stringify(
    {
      ...first,
      results: first.results.map(({ name }) => {
        const all = runs.map((run) => run.results.find((r) => r.name === name)!);
        return {
          name,
          p50Ms: median(all.map((r) => r.p50Ms)),
          p95Ms: median(all.map((r) => r.p95Ms)),
          meanMs: median(all.map((r) => r.meanMs)),
          opsPerSecond: median(all.map((r) => r.opsPerSecond)),
        };
      }),
    },
    null,
    2
  )}\n`
);
