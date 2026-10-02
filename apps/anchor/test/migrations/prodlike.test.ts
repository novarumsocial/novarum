import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createDatabase, dropDatabase } from '../harness/db';
import { lockViolation, runProdlike, sampleLocks } from './prodlike';

describe('production-like upgrade script (smoke)', () => {
  test('runs end to end with tiny sizes and reports timings', async () => {
    const report = await runProdlike({ messages: 500, users: 50, guilds: 5 }, 60);
    expect(report.messages).toBe(500);
    expect(report.bootSeconds).toBeGreaterThan(0);
    expect(report.samples).toBeGreaterThan(0);
    expect(lockViolation(report)).toBeNull();
  }, 60_000);

  test('the sampler measures how long a table stays ACCESS EXCLUSIVE locked', async () => {
    const { database, url } = await createDatabase('prodlike_lock');
    const holder = new SQL(url, { max: 1 });
    try {
      await holder.unsafe('CREATE TABLE locked_table (id int)');
      const sampler = sampleLocks(url, 5);
      await holder.unsafe('BEGIN; LOCK TABLE locked_table IN ACCESS EXCLUSIVE MODE');
      await Bun.sleep(600);
      await holder.unsafe('COMMIT');
      const stats = await sampler.stop();
      expect(stats.table).toBe('locked_table');
      expect(stats.maxExclusiveSeconds).toBeGreaterThan(0.4);
      expect(lockViolation({ ...stats, maxLockSeconds: 0.1 })).toContain('locked_table');
      expect(lockViolation({ ...stats, maxLockSeconds: 30 })).toBeNull();
    } finally {
      await holder.close();
      await dropDatabase(database);
    }
  });
});
