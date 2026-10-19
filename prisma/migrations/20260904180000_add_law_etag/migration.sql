-- Stores the HTTP ETag returned by gesetze-im-internet.de for each law zip,
-- so the daily ingestAll() sync can send If-None-Match and skip the body
-- download for unchanged laws (304).
ALTER TABLE "Law" ADD COLUMN "etag" TEXT;
