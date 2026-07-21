import 'dotenv/config';
import { drizzle } from 'drizzle-orm/bun-sql';
import { getConfig } from '../../utils/config';
import { relations } from './relations';

const db = drizzle({
  connection: process.env.DATABASE_URL || getConfig().server.database_url,
  relations,
});
export { db };
export * from './schema';
export * from './relations';
