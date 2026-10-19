-- Document job scheduling moved from Postgres polling to BullMQ (Redis).
-- Drop the legacy DocumentJob table; queue state now lives in Redis under
-- the BullMQ "document-jobs" queue keyspace.

DROP TABLE IF EXISTS "DocumentJob";
