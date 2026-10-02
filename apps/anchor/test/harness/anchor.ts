import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeConfig, type ConfigOverrides } from './config';
import { anchorRoot } from './env';
import { createDatabase, dropDatabase } from './db';
import { eventually } from './wait';

export type SpawnOptions = {
  name?: string;
  homeserver?: string;
  baseUrl?: string;
  port?: number;
  /** connection string; a fresh database is created (and dropped on stop) when omitted */
  db?: string;
  /** keep s3 CORS setup on (needs Garage); only upload tests need it */
  s3?: boolean;
  config?: ConfigOverrides;
  env?: Record<string, string>;
};

export type RunningAnchor = Awaited<ReturnType<typeof spawnAnchor>>;

export const freePort = () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  return port!;
};

/** spawns `bun src/index.ts` with its own config, database and key dir */
export async function spawnAnchor(options: SpawnOptions = {}) {
  const name = options.name ?? 'anchor';
  const tmp = mkdtempSync(path.join(tmpdir(), `anchor-${name}-`));
  const created = options.db ? null : await createDatabase(name);
  const databaseUrl = options.db ?? created!.url;
  const port = options.port ?? freePort();
  const homeserver = options.homeserver ?? 'localhost';
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;
  const configPath = writeConfig(tmp, {
    ...options.config,
    server: {
      database_url: databaseUrl,
      homeserver,
      base_url: baseUrl,
      listen_port: port,
      ...options.config?.server,
    },
    federation: { key_dir: path.join(tmp, 'keys'), ...options.config?.federation },
    files: { s3_disable_cors: !options.s3, ...options.config?.files },
  });

  const url = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let proc: Bun.Subprocess | null = null;

  const run = (args: string[]) =>
    Bun.spawn(['bun', path.join(anchorRoot, 'src/index.ts'), ...args], {
      cwd: anchorRoot,
      env: { ...process.env, ANCHOR_CONFIG: configPath, ...options.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });

  const pipeLogs = (p: Bun.Subprocess) => {
    for (const stream of [p.stdout, p.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) logs.push(decoder.decode(chunk));
      })();
    }
  };

  async function start() {
    proc = run([]);
    pipeLogs(proc);
    try {
      await eventually(
        async () => {
          if (proc!.exitCode !== null) throw new Error(`anchor exited early:\n${logs.join('')}`);
          const res = await fetch(`${url}/`).catch(() => null);
          return res && (await res.text()) === 'this is anchor';
        },
        { timeout: 60_000, interval: 100, message: 'anchor boot' }
      );
    } catch (error) {
      proc!.kill();
      throw error;
    }
  }

  async function stop() {
    if (proc && proc.exitCode === null) {
      proc.kill();
      await proc.exited;
    }
  }

  await start();

  return {
    name,
    url,
    port,
    homeserver,
    baseUrl,
    databaseUrl,
    configPath,
    keyDir: path.join(tmp, 'keys'),
    logs: () => logs.join(''),
    stop,
    async restart() {
      await stop();
      await start();
    },
    /** runs `src/index.ts cli ...` against this anchor's config and database */
    async cli(...args: string[]) {
      const p = run(['cli', ...args]);
      const [stdout, stderr] = await Promise.all([
        new Response(p.stdout as ReadableStream).text(),
        new Response(p.stderr as ReadableStream).text(),
      ]);
      return { code: await p.exited, stdout, stderr };
    },
    async destroy() {
      await stop();
      if (created) await dropDatabase(created.database);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** boots an anchor with a spawnAnchor's config but a broken boot condition, returning exit info */
export async function bootExpectingExit(options: SpawnOptions & { timeout?: number }) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'anchor-exit-'));
  const configPath = writeConfig(tmp, {
    ...options.config,
    server: {
      database_url: options.db!,
      homeserver: options.homeserver ?? 'localhost',
      base_url: options.baseUrl ?? 'http://localhost:1',
      listen_port: options.port ?? freePort(),
    },
    federation: { key_dir: path.join(tmp, 'keys') },
    files: { s3_disable_cors: true },
  });
  const p = Bun.spawn(['bun', path.join(anchorRoot, 'src/index.ts')], {
    cwd: options.env?.CWD ?? anchorRoot,
    env: { ...process.env, ANCHOR_CONFIG: configPath, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => p.kill(), options.timeout ?? 30_000);
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  const code = await p.exited;
  clearTimeout(timer);
  rmSync(tmp, { recursive: true, force: true });
  return { code, output: stdout + stderr };
}
