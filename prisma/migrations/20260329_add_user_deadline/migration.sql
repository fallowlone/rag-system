CREATE TABLE "UserDeadline" (
  "id"           TEXT         NOT NULL,
  "userId"       TEXT         NOT NULL,
  "label"        TEXT         NOT NULL,
  "deadlineDate" TIMESTAMP(3) NOT NULL,
  "sourceType"   TEXT         NOT NULL,
  "sourceId"     TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserDeadline_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserDeadline_userId_deadlineDate_idx" ON "UserDeadline"("userId", "deadlineDate");
