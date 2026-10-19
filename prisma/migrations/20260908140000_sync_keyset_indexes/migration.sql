-- Keyset-paging indexes for AppSyncService.delta. Each delta leg filters by
-- userId plus a (updatedAt|createdAt|deletedAt) range and orders by the same
-- columns; without these the per-poll queries seq-scan/sort and grow with
-- the tables. (UserDeadline and SyncTombstone already have their equivalents.)
CREATE INDEX "UserDocument_userId_updatedAt_idx" ON "UserDocument"("userId", "updatedAt");
CREATE INDEX "UserTask_userId_updatedAt_idx" ON "UserTask"("userId", "updatedAt");
CREATE INDEX "DocumentInsight_userId_createdAt_idx" ON "DocumentInsight"("userId", "createdAt");
