-- Server-side document analysis (step 2 of the document-quality plan):
-- Sonnet-produced insights (red flags, grey zones, next steps, deadline
-- notes) per ingested app document. Rows cascade when the parent UserDocument
-- is deleted (per-document delete and the GDPR forgetAll sweep both go
-- through UserDocument deletion; forgetAll additionally deletes explicitly).
CREATE TABLE "DocumentInsight" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentInsight_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocumentInsight_userId_documentId_idx" ON "DocumentInsight"("userId", "documentId");
ALTER TABLE "DocumentInsight" ADD CONSTRAINT "DocumentInsight_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "UserDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
