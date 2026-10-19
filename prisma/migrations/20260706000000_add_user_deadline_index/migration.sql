-- Index on UserDeadline(userId, deadlineDate)
-- Speeds up per-user upcoming-deadline lookups (WHERE "userId" = ? ORDER BY "deadlineDate").
-- Table is small; plain CREATE INDEX is fine (no CONCURRENTLY needed).
CREATE INDEX "UserDeadline_userId_deadlineDate_idx" ON "UserDeadline"("userId", "deadlineDate");
