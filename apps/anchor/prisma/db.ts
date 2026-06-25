import postgres from '@prisma-next/postgres/runtime';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };
import { getConfig } from '../utils/config';

export const db = postgres<Contract>({
  contractJson,
  url: getConfig().server.database_url,
});
