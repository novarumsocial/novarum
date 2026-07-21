import 'dotenv/config';
import { drizzle } from 'drizzle-orm/bun-sql';
import { getConfig } from '../../utils/config';

const db = drizzle(process.env.DATABASE_URL || getConfig().server.database_url);
