import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  AppDeadlineRecord,
  AppDeletedIds,
  AppDocumentListItem,
  AppInsightRecord,
  AppSyncInput,
  AppSyncResult,
  AppTaskRecord,
} from "./app-api.types";

export const SYNC_MAX_LIMIT = 500;
/**
 * Tombstones older than this are pruned on read. A device offline longer
 * than the window misses intermediate deletions and must resync from
 * scratch (cursor-less full pull).
 */
const TOMBSTONE_RETENTION_DAYS = 90;

// Pruning on every poll is a wasted write + WAL on a read path (delta is
// throttled at 60/min). The prune is idempotent hygiene — once an hour per
// process is plenty (each replica keeps its own timestamp; a duplicate
// hourly delete across replicas is harmless).
const TOMBSTONE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

/** Keyset position within one synced collection. */
interface CollectionPos {
  /** ISO-8601 instant of the last returned row. */
  t: string;
  /** Id of the last returned row ("" = no tiebreak, matches everything). */
  id: string;
}

/** Opaque sync cursor: per-collection keyset positions. */
interface SyncCursor {
  v: 1;
  docs: CollectionPos | null;
  deadlines: CollectionPos | null;
  tasks: CollectionPos | null;
  insights: CollectionPos | null;
  /**
   * Tombstone (deletion) position. Absent (null) in cursors minted before
   * tombstones existed — parseSyncCursor defaults it to null so stored
   * client cursors keep working.
   */
  deleted: CollectionPos | null;
}

function posOf(t: Date, id: string): CollectionPos {
  return { t: t.toISOString(), id };
}

export function encodeSyncCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Parses a raw cursor query value. Accepts the opaque keyset cursor produced
 * by `encodeSyncCursor` and legacy plain ISO-8601 cursors from pre-keyset
 * clients (treated as (instant, start-of-ids) for every collection, so stored
 * cursors from older app versions keep working). Anything else → 400.
 */
export function parseSyncCursor(raw: string): SyncCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<SyncCursor>;
    if (
      decoded?.v === 1 &&
      "docs" in decoded &&
      "deadlines" in decoded &&
      "tasks" in decoded &&
      "insights" in decoded &&
      [decoded.docs, decoded.deadlines, decoded.tasks, decoded.insights].every(
        (pos) =>
          pos === null ||
          pos === undefined ||
          (typeof pos.t === "string" &&
            typeof pos.id === "string" &&
            !Number.isNaN(new Date(pos.t).getTime())),
      ) &&
      (decoded.deleted === undefined ||
        decoded.deleted === null ||
        (typeof decoded.deleted.t === "string" &&
          typeof decoded.deleted.id === "string" &&
          !Number.isNaN(new Date(decoded.deleted.t).getTime())))
    ) {
      // Pre-tombstone clients stored cursors without `deleted` — default it
      // to null so those cursors keep working (and pick up deletions made
      // while the client was on the old version).
      return {
        v: 1,
        docs: decoded.docs ?? null,
        deadlines: decoded.deadlines ?? null,
        tasks: decoded.tasks ?? null,
        insights: decoded.insights ?? null,
        deleted: decoded.deleted ?? null,
      };
    }
  } catch {
    // Fall through to the legacy ISO attempt below.
  }
  const legacy = new Date(raw);
  if (!Number.isNaN(legacy.getTime())) {
    const pos = posOf(legacy, "");
    return {
      v: 1,
      docs: pos,
      deadlines: { ...pos },
      tasks: { ...pos },
      insights: { ...pos },
      deleted: { ...pos },
    };
  }
  throw new BadRequestException("cursor must be a valid sync cursor");
}

/**
 * Cursor-based incremental pull for the macOS companion app.
 *
 * Each collection is paged by its own (updatedAt, id) keyset, encoded in the
 * opaque cursor. The previous implementation used a single wall-clock
 * `nextCursor = now()` with `updatedAt > cursor` filters: any collection
 * that hit `take: limit` silently lost its overflow rows on the next poll
 * (they were older than `now()`), and rows sharing an updatedAt instant
 * duplicated or vanished across pages. Keyset positions make paging exact.
 */
@Injectable()
export class AppSyncService {
  private readonly logger = new Logger(AppSyncService.name);
  private lastTombstonePruneAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Document page shape shared by the main page and the orphan-insight parent backfill below. */
  private static readonly docSelect = {
    id: true,
    sourceHash: true,
    fileName: true,
    title: true,
    category: true,
    factsCount: true,
    summary: true,
    isActive: true,
    status: true,
    appSource: true,
    expiryDate: true,
    docDate: true,
    createdAt: true,
    updatedAt: true,
    tagLinks: {
      select: { tag: { select: { id: true, name: true, color: true } } },
    },
  } as const;
  async delta(userId: string, input: AppSyncInput): Promise<AppSyncResult> {
    const limit = Math.min(Math.max(input.limit, 1), SYNC_MAX_LIMIT);
    const keysetOrder = [{ updatedAt: "asc" as const }, { id: "asc" as const }];

    let cursor = input.cursor ? parseSyncCursor(input.cursor) : null;
    let resync = false;
    if (cursor?.deleted) {
      // A device offline longer than tombstone retention missed deletions
      // that are already pruned server-side — an incremental delta would
      // leave ghost rows in its cache forever. Restart from scratch and say
      // so; a fresh device (no cursor) already pulls everything with
      // resync=false since it has nothing stale.
      const deletedPos = new Date(cursor.deleted.t).getTime();
      if (deletedPos < Date.now() - TOMBSTONE_RETENTION_DAYS * 86400_000) {
        this.logger.log(
          `Sync for user ${userId}: cursor older than tombstone retention — full resync`,
        );
        cursor = null;
        resync = true;
      }
    }

    const after = (pos: CollectionPos | null | undefined) =>
      pos
        ? {
            OR: [
              { updatedAt: { gt: new Date(pos.t) } },
              { updatedAt: new Date(pos.t), id: { gt: pos.id } },
            ],
          }
        : {};

    const [docs, deadlines, tasks, serverTimeRows] = await Promise.all([
      this.prisma.userDocument.findMany({
        where: { userId, ...after(cursor?.docs) },
        orderBy: keysetOrder,
        take: limit,
        select: AppSyncService.docSelect,
      }),
      this.prisma.userDeadline.findMany({
        where: { userId, ...after(cursor?.deadlines) },
        orderBy: keysetOrder,
        take: limit,
      }),
      this.prisma.userTask.findMany({
        where: { userId, ...after(cursor?.tasks) },
        orderBy: keysetOrder,
        take: limit,
      }),
      // Single clock read for display only — the client's next cursor is the
      // keyset below, never wall-clock time (see class comment).
      // $queryRaw with no interpolation — nothing to parameterize.
      this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`,
    ]);

    // Insights are immutable (created once per document), so createdAt is
    // their change marker. Insights of the documents on this page may long
    // predate the cursor (e.g. a fresh device pulling old documents), so
    // they are fetched uncapped — bounded by page size × a handful of
    // insights per document. Insights created after the cursor position
    // (e.g. via the analyze retry on an old document) page separately with
    // their own keyset, so insight-only changes advance the cursor and can
    // never wedge `hasMore` on.
    //
    // Orphan case: an insight created after the cursor whose parent document
    // is older than the docs cursor (retry on an old document, or a doc read
    // racing the analysis write) would land in `recentInsights` with no
    // parent on the page — and the response can only carry insights through
    // their document. Backfill those parents below so the insight (and the
    // already-advanced insights cursor) is never silently dropped.
    const [pageInsights, recentInsights] = await Promise.all([
      docs.length > 0
        ? this.prisma.documentInsight.findMany({
            where: { userId, documentId: { in: docs.map((d) => d.id) } },
            orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
          })
        : [],
      this.prisma.documentInsight.findMany({
        where: { userId, ...afterCreated(cursor?.insights) },
        orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
        take: limit,
      }),
    ]);

    // pageInsights and recentInsights overlap on a first pull (cursor=null
    // makes `recent` return every insight, including those already carried by
    // the page docs) — dedupe by id so no insight is delivered twice.
    const seenInsightIds = new Set<string>();
    const insightsByDoc = new Map<string, AppInsightRecord[]>();
    for (const row of [...pageInsights, ...recentInsights]) {
      if (seenInsightIds.has(row.id)) continue;
      seenInsightIds.add(row.id);
      const list = insightsByDoc.get(row.documentId) ?? [];
      list.push({
        id: row.id,
        documentId: row.documentId,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        body: row.body,
        createdAt: row.createdAt,
      });
      insightsByDoc.set(row.documentId, list);
    }

    // Orphan-insight backfill (see comment above): parents of recent
    // insights that are not on this page are fetched explicitly and appended,
    // so their insights ride along instead of being dropped while the
    // insights cursor advances past them.
    const pageDocIds = new Set(docs.map((d) => d.id));
    const missingDocIds = [...insightsByDoc.keys()].filter(
      (id) => !pageDocIds.has(id),
    );
    const missingDocs =
      missingDocIds.length > 0
        ? await this.prisma.userDocument.findMany({
            where: { userId, id: { in: missingDocIds } },
            select: AppSyncService.docSelect,
          })
        : [];
    const allDocs = [...docs, ...missingDocs];

    const documents: AppDocumentListItem[] = allDocs.map((doc) => ({
      id: doc.id,
      sourceHash: doc.sourceHash,
      fileName: doc.fileName,
      title: doc.title,
      category: doc.category,
      factsCount: doc.factsCount,
      summary: doc.summary,
      isActive: doc.isActive,
      status: doc.status,
      appSource: doc.appSource,
      expiryDate: doc.expiryDate,
      docDate: doc.docDate,
      createdAt: doc.createdAt,
      tags: doc.tagLinks.map((link) => link.tag),
      insights: insightsByDoc.get(doc.id) ?? [],
    }));

    const deadlineRecords: AppDeadlineRecord[] = deadlines.map((d) => ({
      id: d.id,
      label: d.label,
      deadlineDate: d.deadlineDate,
      sourceType: d.sourceType,
      sourceId: d.sourceId,
      completedAt: d.completedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));

    const taskRecords: AppTaskRecord[] = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      dueDate: t.dueDate,
      status: t.status as AppTaskRecord["status"],
      priority: t.priority as AppTaskRecord["priority"],
      sourceType: t.sourceType,
      sourceDocumentId: t.sourceDocumentId,
      completedAt: t.completedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));

    // Deletion tombstones (see SyncTombstone): ids of synced rows deleted
    // since the cursor, keyed by collection. Without this leg, server-side
    // deletes stayed visible in the device cache forever. Tombstones older
    // than the retention window are pruned below — a device offline longer
    // than that resyncs from scratch.
    const tombstones = await this.prisma.syncTombstone.findMany({
      where: { userId, ...afterDeleted(cursor?.deleted) },
      orderBy: [{ deletedAt: "asc" as const }, { id: "asc" as const }],
      take: limit,
    });
    const deleted: AppDeletedIds = {
      documents: [],
      deadlines: [],
      tasks: [],
    };
    for (const tombstone of tombstones) {
      if (tombstone.collection === "document") {
        deleted.documents.push(tombstone.objectId);
      } else if (tombstone.collection === "deadline") {
        deleted.deadlines.push(tombstone.objectId);
      } else if (tombstone.collection === "task") {
        deleted.tasks.push(tombstone.objectId);
      }
      // Unknown future collections are ignored (forward-compatible).
    }
    await this.maybePruneTombstones(userId);

    const hasMore =
      docs.length === limit ||
      deadlines.length === limit ||
      tasks.length === limit ||
      recentInsights.length === limit ||
      tombstones.length === limit;

    if (hasMore) {
      this.logger.log(
        `Sync delta for user ${userId} hit the page limit (${limit}) — client should page again`,
      );
    }

    if (!serverTimeRows[0]) {
      throw new InternalServerErrorException("database clock unavailable");
    }
    const serverTime = serverTimeRows[0].now;
    // Advance each position past its page; collections with no new rows keep
    // their incoming position (or stay null on a first pull), so the next
    // poll resumes exactly where this one stopped.
    const advance = <T extends { updatedAt: Date; id: string }>(
      rows: T[],
      pos: CollectionPos | null | undefined,
    ): CollectionPos | null =>
      rows.length > 0
        ? posOf(rows[rows.length - 1]!.updatedAt, rows[rows.length - 1]!.id)
        : (pos ?? null);
    const nextCursor = encodeSyncCursor({
      v: 1,
      docs: advance(docs, cursor?.docs),
      deadlines: advance(deadlines, cursor?.deadlines),
      tasks: advance(tasks, cursor?.tasks),
      insights: advanceCreated(recentInsights, cursor?.insights),
      deleted: advanceDeleted(tombstones, cursor?.deleted),
    });
    return {
      serverTime,
      nextCursor,
      documents,
      deadlines: deadlineRecords,
      tasks: taskRecords,
      deleted,
      hasMore,
      resync,
    };
  }

  /**
   * Hourly tombstone hygiene (see TOMBSTONE_PRUNE_INTERVAL_MS). Prune
   * failures only warn — the table growing for another hour is benign,
   * failing the user's read over it would not be.
   */
  private async maybePruneTombstones(userId: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastTombstonePruneAt < TOMBSTONE_PRUNE_INTERVAL_MS) return;
    this.lastTombstonePruneAt = now;
    try {
      await this.prisma.syncTombstone.deleteMany({
        where: {
          userId,
          deletedAt: {
            lt: new Date(Date.now() - TOMBSTONE_RETENTION_DAYS * 86400_000),
          },
        },
      });
    } catch (err) {
      this.logger.warn(
        `Tombstone prune failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function afterCreated(pos: CollectionPos | null | undefined) {
  return pos
    ? {
        OR: [
          { createdAt: { gt: new Date(pos.t) } },
          { createdAt: new Date(pos.t), id: { gt: pos.id } },
        ],
      }
    : {};
}

function advanceCreated<T extends { createdAt: Date; id: string }>(
  rows: T[],
  pos: CollectionPos | null | undefined,
): CollectionPos | null {
  return rows.length > 0
    ? {
        t: rows[rows.length - 1]!.createdAt.toISOString(),
        id: rows[rows.length - 1]!.id,
      }
    : (pos ?? null);
}

function afterDeleted(pos: CollectionPos | null | undefined) {
  return pos
    ? {
        OR: [
          { deletedAt: { gt: new Date(pos.t) } },
          { deletedAt: new Date(pos.t), id: { gt: pos.id } },
        ],
      }
    : {};
}

function advanceDeleted<T extends { deletedAt: Date; id: string }>(
  rows: T[],
  pos: CollectionPos | null | undefined,
): CollectionPos | null {
  return rows.length > 0
    ? {
        t: rows[rows.length - 1]!.deletedAt.toISOString(),
        id: rows[rows.length - 1]!.id,
      }
    : (pos ?? null);
}
