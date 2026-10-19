import {
  berlinDayEnd,
  berlinDayStart,
  berlinDayStartDaysAgo,
} from "./berlin-day";

const HOUR_MS = 60 * 60 * 1_000;

describe("berlin-day DST boundaries", () => {
  it("covers exactly 24h on a normal winter day", () => {
    const start = berlinDayStart(new Date("2026-01-15T12:00:00Z"));

    expect(start.toISOString()).toBe("2026-01-14T23:00:00.000Z");

    const end = berlinDayEnd(start);
    expect(end.toISOString()).toBe("2026-01-15T23:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * HOUR_MS);
  });

  it("covers 23h across the spring-forward transition (2026-03-29, no double-covered hour)", () => {
    const start = berlinDayStart(new Date("2026-03-29T12:00:00Z"));

    // Mar 29 is still CET (UTC+1): midnight Berlin = 23:00Z previous day.
    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");

    // Mar 30 is CEST (UTC+2).
    const end = berlinDayEnd(start);
    expect(end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR_MS);
  });

  it("covers 25h across the fall-back transition (2026-10-25, no dropped hour)", () => {
    const start = berlinDayStart(new Date("2026-10-25T12:00:00Z"));

    // Oct 25 is still CEST (UTC+2).
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z");

    // Oct 26 is CET (UTC+1).
    const end = berlinDayEnd(start);
    expect(end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR_MS);
  });

  it("buckets any instant into its containing Berlin day", () => {
    // 00:30 Berlin (CEST) on Oct 25 belongs to the Oct-25 day that started
    // at 22:00Z Oct 24 — the full 25-hour day must be one window.
    const start = berlinDayStart(new Date("2026-10-24T22:30:00Z"));
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });

  it("steps back whole Berlin calendar days", () => {
    const start = berlinDayStart(new Date("2026-01-15T12:00:00Z"));

    expect(berlinDayStartDaysAgo(start, 6).toISOString()).toBe(
      "2026-01-08T23:00:00.000Z",
    );
  });
});
