import { z } from 'zod';

export const benchResultSchema = z.object({
  schemaVersion: z.literal(2),
  commit: z.string(),
  timestamp: z.string(),
  runtime: z.string(),
  machine: z.string(),
  database: z.string(),
  drizzle: z.string(),
  config: z.record(z.string(), z.number()),
  results: z.array(
    z.object({
      name: z.string(),
      p50Ms: z.number(),
      p95Ms: z.number(),
      meanMs: z.number(),
      opsPerSecond: z.number(),
    })
  ),
});
export type BenchResult = z.infer<typeof benchResultSchema>;

export const readResult = async (path: string) => benchResultSchema.parse(await Bun.file(path).json());
