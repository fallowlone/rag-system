CREATE TABLE "DocumentJob" (
  "id"           TEXT         NOT NULL,
  "userId"       TEXT         NOT NULL,
  "chatId"       TEXT         NOT NULL,
  "fileId"       TEXT         NOT NULL,
  "fileName"     TEXT,
  "caption"      TEXT,
  "lang"         TEXT         NOT NULL DEFAULT 'de',
  "statusMsgId"  INTEGER,
  "status"       TEXT         NOT NULL DEFAULT 'pending',
  "retryCount"   INTEGER      NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DocumentJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentJob_status_createdAt_idx" ON "DocumentJob" ("status", "createdAt");
