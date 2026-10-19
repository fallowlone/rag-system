-- One analysis per document: analyzeAndStore is check-then-act across an
-- LLM call, so concurrent retries would both pay Sonnet and persist
-- duplicate rows. Drop pre-existing duplicates first (keep the earliest),
-- then enforce uniqueness; the service uses skipDuplicates so the loser of
-- a concurrent race becomes a reader of the winner's rows.
DELETE FROM "DocumentInsight" a
USING "DocumentInsight" b
WHERE a."documentId" = b."documentId"
  AND (a."createdAt" > b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" > b."id"));

CREATE UNIQUE INDEX "DocumentInsight_documentId_key" ON "DocumentInsight"("documentId");
