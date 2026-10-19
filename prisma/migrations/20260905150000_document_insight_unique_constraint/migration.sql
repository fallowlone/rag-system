-- The previous migration created the document uniqueness as a standalone
-- UNIQUE INDEX, which enforces correctly but leaves prisma's drift
-- detection seeing a missing table constraint. Swap it for the canonical
-- named constraint in one transaction (drop first: a constraint's backing
-- index would otherwise collide on the same name).
DROP INDEX "DocumentInsight_documentId_key";
ALTER TABLE "DocumentInsight" ADD CONSTRAINT "DocumentInsight_documentId_key" UNIQUE ("documentId");
