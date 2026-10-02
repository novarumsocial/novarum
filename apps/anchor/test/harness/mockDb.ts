import { mock } from 'bun:test';

// unit tests have no database. this swaps `db` in src/db for a stub (the rest of the module,
// schema tables included, stays real). call restoreDb() in afterAll so later files in the same
// bun process see the real thing again.
const dbPath = '../../src/db';
const real = { ...(await import(dbPath)) };

export function mockDb(db: unknown) {
  mock.module(dbPath, () => ({ ...real, db }));
}

export function restoreDb() {
  mock.module(dbPath, () => real);
}
