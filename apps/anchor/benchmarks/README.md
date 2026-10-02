# Query benchmarks

A small Drizzle-only suite for the queries anchor actually runs on hot paths. It measures client-observed latency (p50/p95/mean) and
concurrent throughput, and `compare.ts` turns two runs into a regression gate.

Point `DATABASE_URL` at a disposable PostgreSQL database. The suite applies the migrations, creates everything it needs
under a throwaway `bench-*.invalid` homeserver and removes it again, but it performs real writes.

## Scenarios

- user by primary key, membership by compound key, insert message, update user
- a message page with author and attachments: the latest 50, and one at `offset 5000` on a 10k-message channel
  (`/message/list` paginates by offset, so the deep page is the one that degrades as channels grow)
- guild list for a user in 50 guilds, with read states and pings (`GET /guilds/list`)
- federation nonce lookup + insert on a table pre-filled with 100k rows (every incoming federation request)
- online-user scan on 5k users (the presence loop runs it every 3s)

## Usage

```sh
DATABASE_URL=postgresql://... BENCH_OUTPUT=/tmp/current.json bun run --filter anchor bench

# compare against a baseline (prints a Markdown table, exits 1 on a p95 regression)
bun run --filter anchor bench:compare /tmp/baseline.json /tmp/current.json
# keep the median of several runs
bun apps/anchor/benchmarks/median.ts /tmp/median.json /tmp/run1.json /tmp/run2.json /tmp/run3.json
```

Defaults: 20 warmups, 200 latency samples, 500 throughput operations at concurrency 10. Override with `BENCH_WARMUP`,
`BENCH_SAMPLES`, `BENCH_THROUGHPUT_OPS`, `BENCH_CONCURRENCY`, and the fixture sizes with `BENCH_CHANNEL_MESSAGES`,
`BENCH_NONCES`, `BENCH_ONLINE_USERS`. `BENCH_MAX_REGRESSION` (default `0.2`) is the allowed p95 slowdown and
`BENCH_REPORT_ONLY=1` makes `compare.ts` report without failing.

Only compare runs from the same machine class, database and Bun version. CI (`.github/workflows/anchor-test.yml`, weekly job)
runs the suite three times against a fresh Postgres service, keeps the median per scenario, uploads `main` runs as the
baseline artifact and compares other runs against the latest one.
