import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DocumentCategory } from "../memory/memory.types";

export interface PalaceRooms {
  /** Room id in german_law wing to search (null = search all law chunks) */
  lawRoomId: string | null;
  /** Room id in user_documents wing to search (null = search all docvault chunks) */
  userRoomId: string | null;
}

/** Maps DocumentCategory values to user_documents room ids. */
const CATEGORY_TO_USER_ROOM: Partial<Record<DocumentCategory, string>> = {
  mietvertrag: "mietvertrag",
  jobcenter: "jobcenter",
  visa: "visa",
  versicherung: "versicherung",
  bank: "bank",
  other: "other_docs",
};

@Injectable()
export class PalaceNavigationService {
  private readonly logger = new Logger(PalaceNavigationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Given a document category detected from the user's question,
   * returns the law room and user-doc room to search.
   * Returns nulls when no category is known (search everywhere).
   */
  async resolveRooms(
    category: DocumentCategory | undefined,
  ): Promise<PalaceRooms> {
    if (!category || category === "other") {
      return { lawRoomId: null, userRoomId: null };
    }

    const userRoomId = CATEGORY_TO_USER_ROOM[category] ?? null;
    if (!userRoomId) {
      return { lawRoomId: null, userRoomId: null };
    }

    // Find the law room connected to this user room via a tunnel
    let tunnel: Awaited<ReturnType<typeof this.prisma.tunnel.findFirst>>;
    try {
      tunnel = await this.prisma.tunnel.findFirst({
        where: {
          OR: [{ roomAId: userRoomId }, { roomBId: userRoomId }],
        },
        // Deterministic under multiplicity: seeds hold 1:1, but nothing
        // constrains it — an unordered findFirst would flip rooms silently.
        orderBy: [{ roomAId: "asc" }, { roomBId: "asc" }],
      });
    } catch (err) {
      this.logger.error(
        `Palace: tunnel lookup failed for category=${category}`,
        err instanceof Error ? err.stack : String(err),
      );
      return { lawRoomId: null, userRoomId: null };
    }

    let lawRoomId: string | null = null;
    if (tunnel) {
      lawRoomId =
        tunnel.roomAId === userRoomId ? tunnel.roomBId : tunnel.roomAId;
    }

    this.logger.debug(
      `Palace: category=${category} → userRoom=${userRoomId} lawRoom=${lawRoomId ?? "all"}`,
    );

    return { lawRoomId, userRoomId };
  }

  /**
   * Given a docvault ingest category string, returns the user_documents room id.
   * Falls back to 'other_docs' when no match.
   */
  resolveDocvaultRoom(ragCategory: string): string {
    const known = new Set([
      "mietvertrag",
      "jobcenter",
      "visa",
      "versicherung",
      "bank",
    ]);
    return known.has(ragCategory) ? ragCategory : "other_docs";
  }
}
