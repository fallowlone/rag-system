import { z } from "zod";

/**
 * Strict YYYY-MM-DD calendar date shared by the app-api controllers.
 * The regex alone accepts impossible dates ("2026-13-99", "2026-02-30"),
 * which downstream `new Date(...)` turns into Invalid Date → Prisma 500
 * (tasks dueDate/docDate/expiry) or silently skewed filters. The UTC
 * round-trip rejects both non-existent months/days and day overflows
 * (Feb 30 rolls into March, leap days included).
 */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine(
    (s) => {
      const t = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
    },
    { message: "must be a real calendar date" },
  );

/**
 * UTC-midnight "today" for deadline-day comparisons. Deadline instants on
 * the app path are UTC midnights (...T00:00:00.000Z), so the day boundary
 * must be a UTC midnight too: `new Date(y, m, d)` uses the SERVER timezone
 * (UTC in Docker, Europe/Berlin on a dev Mac), making the same comparison
 * accept or reject boundary dates depending on where the server runs.
 */
export function utcStartOfToday(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
