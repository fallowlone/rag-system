-- macOS companion app ("Dokumente"): tasks, device sessions, document tags,
-- plus UserDocument/UserDeadline extensions for the /app/v1 API.
-- Spec: docs/superpowers/specs/2026-08-21-macos-companion-app-design.md

-- CreateTable
CREATE TABLE "UserTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceDocumentId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTagLink" (
    "documentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "DocumentTagLink_pkey" PRIMARY KEY ("documentId","tagId")
);

-- AlterTable
-- "updatedAt" needs a DEFAULT for existing rows; the Prisma client keeps
-- maintaining it via @updatedAt on every write.
ALTER TABLE "UserDocument"
    ADD COLUMN "title" TEXT,
    ADD COLUMN "docDate" TIMESTAMP(3),
    ADD COLUMN "status" TEXT,
    ADD COLUMN "appSource" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "UserDeadline" ADD COLUMN "completedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "UserTask_userId_status_idx" ON "UserTask"("userId", "status");
CREATE INDEX "UserTask_userId_dueDate_idx" ON "UserTask"("userId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_tokenHash_key" ON "DeviceSession"("tokenHash");
CREATE INDEX "DeviceSession_userId_idx" ON "DeviceSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTag_userId_name_key" ON "DocumentTag"("userId", "name");

-- AddForeignKey
ALTER TABLE "UserTask" ADD CONSTRAINT "UserTask_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "UserDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTagLink" ADD CONSTRAINT "DocumentTagLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "UserDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTagLink" ADD CONSTRAINT "DocumentTagLink_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "DocumentTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
