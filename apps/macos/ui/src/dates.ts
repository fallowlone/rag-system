/**
 * Backend Date fields arrive as full ISO datetimes
 * ("2026-02-01T00:00:00.000Z") while the UI works with calendar days.
 * Truncates defensively — an already-short "YYYY-MM-DD" passes through.
 */
export function toDayString(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Local calendar day as "YYYY-MM-DD" from LOCAL date components — never
 * `toISOString()` (UTC): past local midnight but before 02:00, UTC "today"
 * is still yesterday, which mis-highlights the calendar and un-reddens
 * today's deadlines.
 */
export function todayLocalDay(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * UTC ISO datetime (SQLite `strftime` wall time) → local "YYYY-MM-DD HH:mm"
 * for display. Falls back to the raw UTC slice when unparsable.
 */
export function formatLocalDateTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/**
 * Strict calendar-day validation ("YYYY-MM-DD", real month/day — so
 * "2026-02-30" fails instead of rolling into March). Garbage server dates
 * must render as "—", never as a huge bogus overdue count (Date.UTC/mingw
 * fallback math turns "garbage" into year 0).
 */
export function isValidDayString(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const roundtrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundtrip.getUTCFullYear() === y &&
    roundtrip.getUTCMonth() === m - 1 &&
    roundtrip.getUTCDate() === d
  );
}

/**
 * Whole calendar days from today until the given ISO date(time): 0 = today,
 * negative when overdue. Compares calendar days (not 24h instants): the old
 * `ceil((UTC-midnight − now)/day)` rendered "in 0 Tagen" for today's
 * deadline and flipped overdue only after 00:00Z (01:00/02:00 local).
 * NaN when the input is not a valid calendar day — callers render "—".
 */
export function daysUntilDay(dateStr: string, now: Date = new Date()): number {
  const day = toDayString(dateStr);
  if (!isValidDayString(day)) return NaN;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}
