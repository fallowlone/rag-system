import { IsoDate, utcStartOfToday } from "./iso-date";

describe("IsoDate", () => {
  it.each([
    "2026-09-30",
    "2024-02-29", // leap day exists in 2024
    "2000-02-29", // century leap year
    "1999-12-31",
  ])("accepts real calendar date %p", (date) => {
    expect(IsoDate.safeParse(date).success).toBe(true);
  });

  it.each([
    "2026-13-99", // impossible month/day (the original 500-class)
    "2026-13-01",
    "2026-00-10",
    "2026-02-30", // day overflow rolls into March
    "2023-02-29", // no leap day in 2023
    "1900-02-29", // century non-leap year
    "2026-04-31", // April has 30 days
    "2026-9-3", // wrong shape
    "not-a-date",
  ])("rejects %p", (date) => {
    expect(IsoDate.safeParse(date).success).toBe(false);
  });
});

describe("utcStartOfToday", () => {
  it("returns the UTC-midnight day boundary regardless of server timezone", () => {
    // 00:30 in Berlin (+02:00) is still the previous day in UTC — a local
    // `new Date(y, m, d)` boundary would already call it Sep 5 here.
    expect(
      utcStartOfToday(new Date("2026-09-05T00:30:00+02:00")).toISOString(),
    ).toBe("2026-09-04T00:00:00.000Z");
    expect(
      utcStartOfToday(new Date("2026-09-05T12:00:00Z")).toISOString(),
    ).toBe("2026-09-05T00:00:00.000Z");
  });
});
