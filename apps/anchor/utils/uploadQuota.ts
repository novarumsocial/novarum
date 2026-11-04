import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { attachments, db } from '../src/db';
import { storage } from './services/storage';

export const maxPendingUploads = 20;
export const dailyUploadBytes = 1024 ** 3;
// long enough to finish writing a message after picking a file
export const pendingUploadTtlMs = 60 * 60_000;

export async function uploadQuotaExceeded(uploaderId: string, size: number) {
  const [usage] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${attachments.status} = 'PENDING')`.mapWith(
        Number
      ),
      bytes: sql<number>`coalesce(sum(${attachments.size}), 0)`.mapWith(Number),
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.uploaderId, uploaderId),
        gt(attachments.createdAt, new Date(Date.now() - 24 * 60 * 60_000))
      )
    );
  return usage!.pending >= maxPendingUploads || usage!.bytes + size > dailyUploadBytes;
}

// uploads no message claimed in time: their rows, the objects and any copy a failed claim left
export async function reapPendingUploads(olderThan = new Date(Date.now() - pendingUploadTtlMs)) {
  const stale = await db
    .delete(attachments)
    .where(and(eq(attachments.status, 'PENDING'), lt(attachments.createdAt, olderThan)))
    .returning({ objectKey: attachments.objectKey });
  await Promise.all(
    stale.flatMap(({ objectKey }) =>
      [objectKey, `${objectKey}/claimed`].map((key) =>
        storage
          .file(key)
          .delete()
          .catch(() => {})
      )
    )
  );
  return stale.length;
}

export function startPendingUploadReaper() {
  const timer = setInterval(
    () => reapPendingUploads().catch((e) => console.error('Pending upload cleanup failed:', e)),
    5 * 60_000
  );
  timer.unref();
  return timer;
}
