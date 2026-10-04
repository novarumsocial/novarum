import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { guardedLookup, safePost } from '../../utils/safePost';

const lookup = (allowLocal: boolean, hostname: string) =>
  new Promise<{ error: Error | null | undefined; address?: string }>((resolve) =>
    guardedLookup(allowLocal)(hostname, { family: 4 }, (error: Error | null, address: string) =>
      resolve({ error, address })
    )
  );

describe('guardedLookup', () => {
  test('refuses a name that resolves to a loopback address, unless local targets are allowed', async () => {
    expect((await lookup(false, 'localhost')).error?.message).toContain('private');
    const allowed = await lookup(true, 'localhost');
    expect(allowed.error).toBeNull();
    expect(allowed.address).toBe('127.0.0.1');
  });
});

describe('safePost', () => {
  test('posts to a local server when the config allows local targets (the test config does)', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 201 }) });
    try {
      const res = await safePost(`http://127.0.0.1:${server.port}/x`, { 'content-type': 'text/plain' }, new Uint8Array([1, 2]), 2000);
      expect(res.status).toBe(201);
    } finally {
      void server.stop(true);
    }
  });

  test('goes through the configured egress proxy', async () => {
    const seen: string[] = [];
    const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => (seen.push(request.url), new Response(null, { status: 202 })) });
    const original = process.env.ANCHOR_CONFIG!;
    const dir = mkdtempSync(path.join(tmpdir(), 'safepost-'));
    const config = path.join(dir, 'config.toml');
    writeFileSync(config, `${readFileSync(original, 'utf8')}\n[network]\nproxy_url = "http://127.0.0.1:${proxy.port}"\n`);
    process.env.ANCHOR_CONFIG = config;
    try {
      const res = await safePost('http://127.0.0.1:9/never-reached', {}, new Uint8Array([1]), 2000);
      expect(res.status).toBe(202);
      expect(seen.some((url) => url.includes('/never-reached'))).toBe(true);
    } finally {
      process.env.ANCHOR_CONFIG = original;
      void proxy.stop(true);
      rmSync(dir, { recursive: true });
    }
  });

  test('refuses non-http urls', async () => {
    await expect(safePost('ftp://example.com/x', {}, new Uint8Array(), 1000)).rejects.toThrow();
  });
});
