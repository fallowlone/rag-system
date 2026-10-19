-- Phase 3a: linear conversation history + palace foundation.
--
-- 1. Add wing/room palace columns to UserMemory so memories can be filed under
--    a palace location ("user_chat", "user_documents", "german_law", ...).
-- 2. New UserDiary table — one AAAK-compressed entry per user per day,
--    populated by the nightly batch (Phase 3b) and embedded for retrieval.

ALTER TABLE "UserMemory"
  ADD COLUMN IF NOT EXISTS "wing" TEXT,
  ADD COLUMN IF NOT EXISTS "room" TEXT;

CREATE INDEX IF NOT EXISTS "UserMemory_userId_wing_room_idx"
  ON "UserMemory" ("userId", "wing", "room");

CREATE TABLE IF NOT EXISTS "UserDiary" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "date"      TIMESTAMP(3) NOT NULL,
    "entry"     TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDiary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserDiary_userId_date_key"
  ON "UserDiary" ("userId", "date");

CREATE INDEX IF NOT EXISTS "UserDiary_userId_date_idx"
  ON "UserDiary" ("userId", "date");
