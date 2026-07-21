import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { getConfig } from './utils/config';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || getConfig().server.database_url,
  },

  schemaFilter: ['public'],

  // verbose: true,
  strict: true,
});
