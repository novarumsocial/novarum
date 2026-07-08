import { defineConfig } from '@prisma-next/postgres/config';
import { getConfig } from './utils/config';

export default defineConfig({
  contract: './prisma/contract.prisma',
  db: {
    connection: process.env.DATABASE_URL || getConfig().server.database_url,
  },
});
