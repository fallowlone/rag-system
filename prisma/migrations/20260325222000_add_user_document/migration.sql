-- CreateTable: UserDocument
CREATE TABLE "UserDocument" (
    "id"         TEXT         NOT NULL,
    "userId"     TEXT         NOT NULL,
    "fileName"   TEXT,
    "category"   TEXT         NOT NULL,
    "sourceHash" TEXT         NOT NULL,
    "factsCount" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDocument_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on sourceHash (one document record per unique file)
CREATE UNIQUE INDEX "UserDocument_sourceHash_key" ON "UserDocument" ("sourceHash");

-- Index for listing documents by user
CREATE INDEX "UserDocument_userId_idx" ON "UserDocument" ("userId");

-- Add documentId FK to UserMemory
ALTER TABLE "UserMemory" ADD COLUMN "documentId" TEXT;

ALTER TABLE "UserMemory"
    ADD CONSTRAINT "UserMemory_documentId_fkey"
    FOREIGN KEY ("documentId")
    REFERENCES "UserDocument" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

CREATE INDEX "UserMemory_documentId_idx" ON "UserMemory" ("documentId")
    WHERE "documentId" IS NOT NULL;
