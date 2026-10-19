-- Nightly batch memory consolidation tables.
--
-- The composite unique on UserDocument (userId, sourceHash) was already
-- introduced by 20260418160000_batch_b_data_layer; this migration only
-- creates the new tables for the nightly batch pipeline.

CREATE TABLE IF NOT EXISTS "ConversationLog" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "role"      TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ConversationLog_userId_createdAt_idx"
  ON "ConversationLog" ("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "BatchJobState" (
    "userId"         TEXT NOT NULL,
    "processedDate"  TIMESTAMP(3) NOT NULL,
    "status"         TEXT NOT NULL,
    "factsExtracted" INTEGER NOT NULL DEFAULT 0,
    "factsConflicts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage"   TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"    TIMESTAMP(3),

    CONSTRAINT "BatchJobState_pkey" PRIMARY KEY ("userId", "processedDate")
);

CREATE TABLE IF NOT EXISTS "ConflictPushState" (
    "conflictGroupId" TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "lastPushedAt"    TIMESTAMP(3) NOT NULL,
    "pushCount"       INTEGER NOT NULL DEFAULT 0,
    "resolvedAt"      TIMESTAMP(3),

    CONSTRAINT "ConflictPushState_pkey" PRIMARY KEY ("conflictGroupId")
);

CREATE INDEX IF NOT EXISTS "ConflictPushState_userId_resolvedAt_idx"
  ON "ConflictPushState" ("userId", "resolvedAt");
