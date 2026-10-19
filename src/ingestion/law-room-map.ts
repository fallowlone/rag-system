/**
 * Single source of truth for mapping a Law.id (Gesetz abbreviation, e.g.
 * "bgb", "sgb_2") to the german_law wing Room id it belongs to.
 *
 * Consumed by:
 * - prisma/seed.ts (idempotent backfill of existing LawChunk rows)
 * - IngestionService.ingestLaw (roomId written on every (re-)ingest)
 */
export interface LawRoomMapping {
  pattern: RegExp;
  roomId: string;
}

export const LAW_ROOM_MAP: LawRoomMapping[] = [
  { pattern: /^bgb$/i, roomId: "mietrecht" },
  { pattern: /^sgb_(2|12)$/i, roomId: "sozialrecht" },
  // asylblg/asylvfg_1992 are real lawIds (see retrieval call sites) that the
  // old aufenthg|asylg prefix missed — they fell to general_law while the
  // visa tunnel points at auslaenderrecht.
  { pattern: /^(aufenthg|asylg|asylblg|asylvfg)/i, roomId: "auslaenderrecht" },
  { pattern: /^stgb$/i, roomId: "strafrecht" },
];

/** Room id used when no pattern in LAW_ROOM_MAP matches the lawId. */
export const DEFAULT_LAW_ROOM_ID = "general_law";

/**
 * Resolves the german_law wing Room id for a given lawId, falling back to
 * DEFAULT_LAW_ROOM_ID when no pattern matches.
 */
export function resolveRoomForLaw(lawId: string): string {
  for (const { pattern, roomId } of LAW_ROOM_MAP) {
    if (pattern.test(lawId)) return roomId;
  }
  return DEFAULT_LAW_ROOM_ID;
}
