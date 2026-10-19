-- A single analysis legitimately produces up to 8 insights per document
-- (red_flag/grey_zone/next_step/deadline_note), but the documentId-only
-- unique constraint turned createMany(skipDuplicates: true) into
-- ON CONFLICT DO NOTHING against the first row of the same statement —
-- silently discarding every insight but one. Widen to the composite
-- (documentId, kind, title): concurrent double-analyze retries still
-- dedupe via skipDuplicates, distinct insights persist side by side.
-- No data backfill: rows previously discarded are unrecoverable from the
-- DB (re-run POST /app/v1/documents/:id/analyze for affected documents).
ALTER TABLE "DocumentInsight" DROP CONSTRAINT "DocumentInsight_documentId_key";
ALTER TABLE "DocumentInsight" ADD CONSTRAINT "DocumentInsight_documentId_kind_title_key" UNIQUE ("documentId", "kind", "title");
