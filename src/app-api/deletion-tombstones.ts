/**
 * Deletion tombstones for sync: every delete path that removes a synced row
 * (documents, deadlines, tasks) records one tombstone per deleted row so
 * `AppSyncService.delta` can tell Mac clients to drop their local copies.
 * Without this, server-side deletes stayed visible in the device cache
 * forever (including GDPR-erased rows after forgetAll).
 */

/** Synced collections with deletable rows. */
export const TOMBSTONE_COLLECTIONS = ["document", "deadline", "task"] as const;

export type TombstoneCollection = (typeof TOMBSTONE_COLLECTIONS)[number];

export interface TombstoneEntry {
  collection: TombstoneCollection;
  objectId: string;
}

/**
 * Minimal structural surface of PrismaService / a transaction client needed
 * to record tombstones — lets callers pass either `this.prisma` or an
 * interactive-transaction `tx`.
 */
export interface TombstoneWriter {
  syncTombstone: {
    createMany: (args: {
      data: Array<{
        userId: string;
        collection: string;
        objectId: string;
      }>;
      skipDuplicates: boolean;
    }) => Promise<unknown>;
  };
}

/**
 * Records tombstones idempotently (re-deletes and double sweeps dedupe via
 * the @@unique([userId, collection, objectId]) constraint). No-op on an
 * empty entry list.
 */
export async function recordTombstones(
  db: TombstoneWriter,
  userId: string,
  entries: TombstoneEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.syncTombstone.createMany({
    data: entries.map((entry) => ({
      userId,
      collection: entry.collection,
      objectId: entry.objectId,
    })),
    skipDuplicates: true,
  });
}
