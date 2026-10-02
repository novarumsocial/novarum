// bun test/federation/run.ts [up|down|-- bun test args...]
// Brings the stack up, runs `bun test` over test/federation, always tears it down and exits with the TEST exit code.
// Env: FED_SUITE=smoke|full|soak (default full), FED_KEEP=1 (leave it up), FED_SKIP_UP=1 (reuse a running stack),
//      FED_BUILD_CACHE=gha (buildx gha cache for the anchor image).
import { Glob } from 'bun';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { anchorRoot } from '../harness/env';
import { anchors, compose, federationDir, startStack, stopStack } from '../harness/federation';

const env = z
  .object({
    FED_SUITE: z.enum(['smoke', 'full', 'soak']).default('full'),
    FED_KEEP: z.string().optional(),
    FED_SKIP_UP: z.string().optional(),
    FED_BUILD_CACHE: z.string().optional(),
  })
  .parse(process.env);

const sub = process.argv[2];
if (sub === 'up') {
  await startStack();
  process.exit(0);
}
if (sub === 'down') {
  await stopStack();
  process.exit(0);
}

const isSoak = (f: string) => f.endsWith('.soak.test.ts');
const isNightly = (f: string) => f.endsWith('.nightly.test.ts');
const files = [...new Glob('test/federation/**/*.test.ts').scanSync({ cwd: anchorRoot })]
  .filter((f) => (env.FED_SUITE === 'soak' ? isSoak(f) : env.FED_SUITE === 'smoke' ? !isSoak(f) && !isNightly(f) : !isSoak(f)))
  .sort();
const extra = process.argv.slice(sub === '--' ? 3 : 2);

const sh = async (cmd: string[], cwd = anchorRoot) => (await Bun.spawn(cmd, { cwd, stdio: ['inherit', 'inherit', 'inherit'] }).exited);

async function saveArtifacts() {
  const dir = path.join(federationDir, 'artifacts');
  mkdirSync(dir, { recursive: true });
  for (const s of ['a', 'b', 'c', 'p', 'q'] as const) {
    const res = await compose(['logs', '--no-color', '--no-log-prefix', anchors[s].service], { allowFail: true });
    writeFileSync(path.join(dir, `${anchors[s].service}.log`), res.stdout + res.stderr);
    const dump = await compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'novarum', anchors[s].db], { allowFail: true });
    writeFileSync(path.join(dir, `${anchors[s].db}.sql`), dump.stdout);
  }
  for (const s of ['fake', 'dns', 'canary', 'canary-a', 'canary-p', 'canary-meta', 'proxy', 'b-proxy']) {
    const res = await compose(['logs', '--no-color', '--no-log-prefix', s], { allowFail: true });
    writeFileSync(path.join(dir, `${s}.log`), res.stdout + res.stderr);
  }
  console.log(`[fed] failure artifacts in ${dir}`);
}

let code = 1;
try {
  if (!env.FED_SKIP_UP) {
    if (env.FED_BUILD_CACHE === 'gha') {
      // best effort: seed the local image from the GitHub Actions layer cache, then compose's --build is a cache hit
      await sh(['docker', 'buildx', 'build', '-f', 'apps/anchor/Dockerfile', '-t', 'anchor-test:local', '--cache-from', 'type=gha', '--cache-to', 'type=gha,mode=max', '--load', '.'], path.resolve(anchorRoot, '../..'));
    }
    await startStack();
  }
  if (files.length === 0) {
    console.log(`[fed] no test files for suite ${env.FED_SUITE}`);
    code = 0;
  } else {
    code = await sh(['bun', 'test', ...files, ...extra]);
    if (code !== 0) await saveArtifacts();
  }
} catch (error) {
  console.error(error);
  await saveArtifacts().catch(() => null);
} finally {
  if (env.FED_KEEP) console.log('[fed] FED_KEEP=1: stack left running (`bun test/federation/run.ts down` to remove it)');
  else await stopStack();
}
process.exit(code);
