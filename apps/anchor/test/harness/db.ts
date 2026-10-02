import { SQL } from 'bun';
import { adminDatabaseUrl } from './env';

const admin = () => new SQL(adminDatabaseUrl);

const safeName = (name: string) => name.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 40);

export function databaseUrl(database: string) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** creates an empty database named anchor_<name>_<rand> and returns its connection string */
export async function createDatabase(name: string) {
  const database = `anchor_${safeName(name)}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = admin();
  try {
    await sql.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await sql.close();
  }
  return { database, url: databaseUrl(database) };
}

export async function dropDatabase(database: string) {
  const sql = admin();
  try {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await sql.close();
  }
}

/** one-off connection to a test database, closed by the caller */
export const connect = (url: string) => new SQL(url);
