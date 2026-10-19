import { DEFAULT_LAW_ROOM_ID, resolveRoomForLaw } from "./law-room-map";

describe("resolveRoomForLaw", () => {
  it("maps bgb to mietrecht", () => {
    expect(resolveRoomForLaw("bgb")).toBe("mietrecht");
  });

  it("maps sgb_2 to sozialrecht", () => {
    expect(resolveRoomForLaw("sgb_2")).toBe("sozialrecht");
  });

  it("maps sgb_12 to sozialrecht", () => {
    expect(resolveRoomForLaw("sgb_12")).toBe("sozialrecht");
  });

  it("maps lawIds starting with aufenthg to auslaenderrecht", () => {
    expect(resolveRoomForLaw("aufenthg_2004")).toBe("auslaenderrecht");
  });

  it("maps lawIds starting with asylg to auslaenderrecht", () => {
    expect(resolveRoomForLaw("asylg")).toBe("auslaenderrecht");
  });

  it("maps asylblg and asylvfg_1992 to auslaenderrecht (not general_law)", () => {
    expect(resolveRoomForLaw("asylblg")).toBe("auslaenderrecht");
    expect(resolveRoomForLaw("asylvfg_1992")).toBe("auslaenderrecht");
  });

  it("maps stgb to strafrecht", () => {
    expect(resolveRoomForLaw("stgb")).toBe("strafrecht");
  });

  it("is case-insensitive", () => {
    expect(resolveRoomForLaw("BGB")).toBe("mietrecht");
  });

  it("falls back to general_law for unknown lawIds", () => {
    expect(resolveRoomForLaw("milchv")).toBe(DEFAULT_LAW_ROOM_ID);
  });

  it("falls back to general_law for docvault", () => {
    expect(resolveRoomForLaw("docvault")).toBe(DEFAULT_LAW_ROOM_ID);
  });

  it("does not match lawIds that merely contain bgb as a substring", () => {
    expect(resolveRoomForLaw("agb_ddr")).toBe(DEFAULT_LAW_ROOM_ID);
  });
});
