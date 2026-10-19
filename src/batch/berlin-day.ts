import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { addDays, startOfDay, subDays } from "date-fns";

export const BERLIN_TZ = "Europe/Berlin";

/**
 * Berlin-midnight (as a UTC instant) of the calendar day containing `instant`.
 * All nightly windows are parameterized by this, so every computation agrees
 * on day boundaries even across DST transitions.
 */
export function berlinDayStart(instant: Date): Date {
  return fromZonedTime(startOfDay(toZonedTime(instant, BERLIN_TZ)), BERLIN_TZ);
}

/**
 * Next Berlin midnight after a Berlin-midnight instant — the exclusive end of
 * that calendar day. NOT `+24h`: on DST transition days Berlin is 23/25 hours
 * long, and a fixed offset would double-cover one hour in spring or silently
 * drop the 23:00–00:00 hour in autumn.
 */
export function berlinDayEnd(dayStart: Date): Date {
  return fromZonedTime(
    startOfDay(addDays(toZonedTime(dayStart, BERLIN_TZ), 1)),
    BERLIN_TZ,
  );
}

/** Berlin midnight `n` days before the given Berlin-midnight instant. */
export function berlinDayStartDaysAgo(dayStart: Date, n: number): Date {
  return fromZonedTime(
    startOfDay(subDays(toZonedTime(dayStart, BERLIN_TZ), n)),
    BERLIN_TZ,
  );
}
