-- Phase 3e: conflict detection in the nightly batch.
--
-- A new fact whose cosine similarity to an existing memory falls in the grey
-- 0.55–0.85 band is filed as a "pending" conflict. Both rows share a
-- conflictGroupId so the morning push job can present the user with a
-- single resolution prompt.

ALTER TABLE "UserMemory"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "conflictGroupId" TEXT;

CREATE INDEX IF NOT EXISTS "UserMemory_userId_conflictGroupId_idx"
  ON "UserMemory" ("userId", "conflictGroupId");
