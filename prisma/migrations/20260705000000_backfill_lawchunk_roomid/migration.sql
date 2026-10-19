-- Data migration (no schema change): backfill "LawChunk"."roomId" for rows
-- that were inserted before ingestLaw started writing it. Uses the same
-- lawId -> Room mapping as src/ingestion/law-room-map.ts (LAW_ROOM_MAP /
-- resolveRoomForLaw), hardcoded here since data migrations cannot import
-- application code.
--
-- Docvault chunks (lawId = 'docvault') are out of scope for this fix; they
-- are scoped by a separate task. Only rows with roomId still NULL are
-- touched, so this is safe to run again.
UPDATE "LawChunk"
SET "roomId" = CASE
  WHEN "lawId" ~* '^bgb$' THEN 'mietrecht'
  WHEN "lawId" ~* '^sgb_(2|12)$' THEN 'sozialrecht'
  WHEN "lawId" ~* '^(aufenthg|asylg)' THEN 'auslaenderrecht'
  WHEN "lawId" ~* '^stgb$' THEN 'strafrecht'
  ELSE 'general_law'
END
WHERE "roomId" IS NULL
  AND "lawId" != 'docvault';
