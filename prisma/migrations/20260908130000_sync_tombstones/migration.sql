-- Sync deletions to the macOS client. delta() previously returned only
-- existing rows, so server-side deletes (Telegram /deletedoc, DELETE
-- /app/v1/documents/:id, task deletes, forgetAll) stayed visible in the
-- Mac's local cache forever. Delete paths now write one tombstone per
-- deleted synced row; delta() serves them as `deleted` and the client drops
-- the matching local rows. Tombstones older than 90 days are pruned on read
-- (a device offline longer resyncs from scratch).
CREATE TABLE "SyncTombstone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncTombstone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncTombstone_userId_collection_objectId_key" ON "SyncTombstone"("userId", "collection", "objectId");
CREATE INDEX "SyncTombstone_userId_deletedAt_idx" ON "SyncTombstone"("userId", "deletedAt");
