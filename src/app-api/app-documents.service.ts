import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UserMemoryService } from "../memory/user-memory.service";
import { DocvaultService } from "../rag/docvault.service";
import { InjectionClassifierService } from "../rag/injection-classifier.service";
import type { InjectionVerdict } from "../rag/injection-classifier.service";
import { DocumentQualityService } from "./document-quality.service";
import { MAX_DEADLINE_HORIZON_DAYS } from "../deadlines/deadline.service";
import { extractionFingerprint } from "./extraction-hash";
import { recordTombstones } from "./deletion-tombstones";
import { utcStartOfToday } from "./iso-date";
import {
  DocumentAnalysisService,
  DocumentAnalysisSource,
} from "./document-analysis.service";
import {
  AppDocumentIngestInput,
  AppDocumentIngestResult,
  AppDocumentListItem,
  AppInsightRecord,
} from "./app-api.types";

/**
 * Imported, not mirrored: this used to be a hand-copied 365 that had already
 * drifted from the other two copies (`saveDeadlinesFromDocument` applied no
 * bound at all, so an expiryDate three years out was stored while the same
 * date in `deadlines[]` was dropped).
 */
const MAX_FUTURE_DAYS = MAX_DEADLINE_HORIZON_DAYS;
const INDEX_TEXT_MAX_CHARS = 20_000;
const CLASSIFY_INPUT_MAX_CHARS = 8_000;

/**
 * Ingestion of local-model document extractions for the macOS companion app.
 *
 * The payload is everything the server ever sees of a document: the raw file
 * (and its full text) stays on the device. Here it is injection-classified,
 * persisted as UserDocument + UserMemory facts, indexed into the owner-scoped
 * docvault (unified law+documents search), expanded into UserDeadline rows,
 * and tagged.
 */
@Injectable()
export class AppDocumentsService {
  private readonly logger = new Logger(AppDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userMemory: UserMemoryService,
    private readonly docvault: DocvaultService,
    private readonly injectionClassifier: InjectionClassifierService,
    private readonly quality: DocumentQualityService,
    private readonly analysis: DocumentAnalysisService,
  ) {}

  async ingest(
    userId: string,
    input: AppDocumentIngestInput,
  ): Promise<AppDocumentIngestResult> {
    const verdict = await this.classifyExtraction(userId, input);
    if (verdict === "INJECTION") {
      this.logger.warn(
        `Ingest rejected for user ${userId}: injection verdict on extraction payload`,
      );
      throw new BadRequestException(
        "Document rejected: prompt injection detected in extraction",
      );
    }

    const indexText = this.buildIndexText(input);
    // Identifies the EXTRACTION, where sourceHash identifies the file. Without
    // it a re-extraction of the same document is indistinguishable from a
    // re-upload, which is why every improvement to extraction used to be
    // invisible for documents already stored.
    const fingerprint = extractionFingerprint(input);

    const expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;
    const { doc, created } = await this.userMemory.createDocument(
      userId,
      input.sourceHash,
      input.category,
      input.facts.length,
      input.fileName ?? input.title,
      indexText,
      input.summary,
      input.isActive,
      expiryDate,
      {
        title: input.title,
        docDate: input.docDate ? new Date(input.docDate) : null,
        status: input.isActive ? "active" : "closed",
        appSource: true,
        extractionHash: fingerprint,
      },
    );

    if (!created) {
      return this.healDuplicate(
        userId,
        doc.id,
        input,
        indexText,
        doc.fullText,
        doc.extractionHash ?? null,
        fingerprint,
      );
    }

    // Explicit deadlines → UserDeadline. Validated against the same bounds as
    // DeadlineService (no past dates, max 365 days ahead). The daily 09:00
    // Berlin deadline tracker picks these rows up automatically.
    //
    // BEFORE the facts on purpose: `rememberBatch` fires a regex pass over
    // each fact's text that also writes deadlines, and its dedup can only skip
    // a day the document already covers if that row exists by then. The other
    // order produced two rows for the same Frist.
    const deadlineRows = this.buildDeadlineRows(userId, doc.id, input);
    if (deadlineRows.length > 0) {
      await this.prisma.userDeadline.createMany({ data: deadlineRows });
    }

    // Facts → UserMemory (BGE-M3 embeddings are generated inside rememberBatch)
    if (input.facts.length > 0) {
      await this.userMemory.rememberBatch(
        userId,
        input.facts.map((f) => f.content),
        "document",
        input.sourceHash,
        doc.id,
      );
    }

    await this.indexAndTag(userId, doc.id, indexText, input);

    // Server-side LLM analysis, best-effort: facts, deadlines and the search
    // index are already committed, so an analysis failure (or refusal) must
    // not fail the ingest — the app retries via POST :id/analyze.
    const insights = await this.analyzeBestEffort(
      userId,
      doc.id,
      input,
      indexText,
    );

    this.logger.log(
      `App document ingested for user ${userId}: ${input.facts.length} facts, ` +
        `${deadlineRows.length} deadlines, doc ${doc.id}`,
    );

    return {
      documentId: doc.id,
      created: true,
      factsStored: input.facts.length,
      deadlinesCreated: deadlineRows.length,
      quality: this.quality.assess(input),
      insights,
      // Deliberately not auto-committed: the app must confirm each suggestion
      // before POSTing it to /app/v1/tasks.
      suggestedTasks: input.obligations,
    };
  }

  /**
   * Completeness repair for the duplicate path. Ingest is not transactional
   * across steps (createDocument → rememberBatch → createMany → indexAndTag
   * → analyzeBestEffort), so a crash/restart between steps leaves a document
   * row without facts/deadlines/index — and a retry with the same sourceHash
   * lands here. Each step below only runs when its rows are entirely absent
   * (rememberBatch and deadline createMany are each atomic, so partial
   * presence within a step cannot happen; re-running them would duplicate).
   * indexAndTag is an atomic replace + idempotent upserts, safe to re-run.
   */
  /**
   * Rebuilds a document from a NEW extraction of the same file.
   *
   * This is the path that makes improving extraction worth anything. The
   * duplicate branch below only ever filled in gaps — it wrote facts and
   * deadlines when their count was exactly zero and never touched the
   * document's own fields or its insights — so a document re-extracted with a
   * better model, a fixed prompt or a new backstop label kept its old data
   * forever, and the only way out was to delete and re-upload.
   *
   * Everything derived from the extraction is replaced, not merged: merging
   * would leave facts from an extraction nobody can reproduce alongside facts
   * from the current one, with no way to tell them apart.
   *
   * Cost is deliberate and bounded: one re-embedding of the facts and one
   * Sonnet analysis per re-extracted document. `healDuplicate`'s no-op branch
   * still covers the ordinary re-push, so this only runs when the extraction
   * actually changed.
   */
  private async reingestChangedExtraction(
    userId: string,
    documentId: string,
    input: AppDocumentIngestInput,
    indexText: string,
    fingerprint: string,
  ): Promise<AppDocumentIngestResult> {
    // Captured before the delete: synced devices need a tombstone per removed
    // deadline or they keep showing rows the server no longer has.
    const doomedDeadlines = await this.prisma.userDeadline.findMany({
      where: { userId, sourceId: documentId },
      select: { id: true },
    });

    const expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.userMemory.deleteMany({ where: { userId, documentId } });
      await tx.userDeadline.deleteMany({ where: { userId, sourceId: documentId } });
      // Insights are computed FROM the extraction, so a changed extraction
      // invalidates them. Dropping them here is what lets analyzeBestEffort
      // below recompute instead of returning the stale set.
      await tx.documentInsight.deleteMany({ where: { userId, documentId } });
      await tx.documentTagLink.deleteMany({ where: { documentId } });
      // updateMany, not update: userId-scoped, same IDOR discipline as the
      // rest of this module.
      await tx.userDocument.updateMany({
        where: { id: documentId, userId },
        data: {
          category: input.category,
          factsCount: input.facts.length,
          fileName: input.fileName ?? input.title ?? null,
          fullText: indexText,
          summary: input.summary ?? null,
          isActive: input.isActive,
          expiryDate,
          title: input.title ?? null,
          docDate: input.docDate ? new Date(input.docDate) : null,
          status: input.isActive ? "active" : "closed",
          extractionHash: fingerprint,
        },
      });
      await recordTombstones(
        tx,
        userId,
        doomedDeadlines.map((d) => ({
          collection: "deadline" as const,
          objectId: d.id,
        })),
      );
    });

    // A refusal remembered for this document describes the OLD extraction;
    // the input has changed, so the memo must not suppress the new analysis.
    this.analysis.forgetRefusal(documentId);

    // Deadlines before facts — the regex pass inside rememberBatch dedupes
    // against the document's own rows and can only see them if they exist.
    const deadlineRows = this.buildDeadlineRows(userId, documentId, input);
    if (deadlineRows.length > 0) {
      await this.prisma.userDeadline.createMany({ data: deadlineRows });
    }
    if (input.facts.length > 0) {
      await this.userMemory.rememberBatch(
        userId,
        input.facts.map((f) => f.content),
        "document",
        input.sourceHash,
        documentId,
      );
    }
    await this.indexAndTag(userId, documentId, indexText, input);
    const insights = await this.analyzeBestEffort(
      userId,
      documentId,
      input,
      indexText,
    );

    this.logger.log(
      `Document ${documentId} rebuilt from a new extraction: ${input.facts.length} facts, ${deadlineRows.length} deadlines`,
    );

    return {
      documentId,
      // Not "created" — the document existed. The client uses this to decide
      // whether to apply backend suggestions, and a rebuild is not a new
      // document.
      created: false,
      factsStored: input.facts.length,
      deadlinesCreated: deadlineRows.length,
      quality: this.quality.assess(input),
      insights,
      suggestedTasks: input.obligations,
    };
  }

  private async healDuplicate(
    userId: string,
    documentId: string,
    input: AppDocumentIngestInput,
    indexText: string,
    storedIndexText: string | null,
    storedFingerprint: string | null,
    fingerprint: string,
  ): Promise<AppDocumentIngestResult> {
    // The same file, extracted differently, is NOT a duplicate. A NULL stored
    // fingerprint (row written before the column existed) counts as changed:
    // those rows are precisely the ones holding a stale extraction, so the
    // first re-push of each rebuilds it once and then settles.
    if (storedFingerprint !== fingerprint) {
      this.logger.log(
        `Document ${documentId} for user ${userId} was re-extracted (fingerprint ${
          storedFingerprint ?? "unknown"
        } → ${fingerprint}) — rebuilding it`,
      );
      return this.reingestChangedExtraction(
        userId,
        documentId,
        input,
        indexText,
        fingerprint,
      );
    }

    this.logger.log(
      `Duplicate upload for user ${userId} (same file, same extraction) — checking document ${documentId} for partial-ingest gaps`,
    );
    // Deadlines before facts, same reason as the create path: the regex pass
    // inside rememberBatch can only skip a day the document already covers if
    // the structured row is already there.
    const deadlineRows = this.buildDeadlineRows(userId, documentId, input);
    let deadlinesCreated = 0;
    if (deadlineRows.length > 0) {
      const stored = await this.prisma.userDeadline.count({
        where: { userId, sourceId: documentId },
      });
      if (stored === 0) {
        await this.prisma.userDeadline.createMany({ data: deadlineRows });
        deadlinesCreated = deadlineRows.length;
        this.logger.log(
          `Healed duplicate document ${documentId}: stored ${deadlinesCreated} missing deadlines`,
        );
      }
    }

    let factsStored = 0;
    if (input.facts.length > 0) {
      const stored = await this.prisma.userMemory.count({
        where: { userId, documentId },
      });
      if (stored === 0) {
        await this.userMemory.rememberBatch(
          userId,
          input.facts.map((f) => f.content),
          "document",
          input.sourceHash,
          documentId,
        );
        factsStored = input.facts.length;
        this.logger.log(
          `Healed duplicate document ${documentId}: stored ${factsStored} missing facts`,
        );
      }
    }

    // documentId is a UUID (no LIKE wildcards), so startsWith is exact here.
    const [chunkCount, linkCount] = await Promise.all([
      this.prisma.lawChunk.count({
        where: {
          lawId: "docvault",
          ownerUserId: userId,
          normKey: { startsWith: `${documentId}_` },
        },
      }),
      this.prisma.documentTagLink.count({ where: { documentId } }),
    ]);
    const uniqueTags = [
      ...new Set(input.tags.map((t) => t.trim()).filter(Boolean)),
    ];

    // The index text is a pure function of the extraction payload, so a
    // mismatch means the FORMAT changed since this document was first
    // ingested — as it did when `Pflichten:` was added, leaving every
    // earlier document without its obligations in fullText, in its docvault
    // chunks and in the analysis prompt.
    //
    // There is no server-side backfill for that: the payload itself is never
    // persisted, so only the device that still holds the extraction JSON can
    // supply it. Re-deriving on mismatch is what makes the repair possible at
    // all — and it generalizes, so the next format change heals itself on
    // re-push instead of needing a migration.
    const staleIndex = storedIndexText !== indexText;

    if (
      chunkCount === 0 ||
      staleIndex ||
      (uniqueTags.length > 0 && linkCount === 0)
    ) {
      await this.indexAndTag(userId, documentId, indexText, input);
      this.logger.log(
        `Healed duplicate document ${documentId}: rebuilt index/tags${staleIndex ? " (index text was stale)" : ""}`,
      );
    }

    if (staleIndex) {
      // userId-scoped updateMany, not update-by-id: same IDOR discipline as
      // the rest of this module.
      await this.prisma.userDocument.updateMany({
        where: { id: documentId, userId },
        data: { fullText: indexText },
      });
      // Insights are NOT recomputed here. Re-indexing is local embedding work
      // (compute, no API spend); re-analysis is a Sonnet call per document,
      // and silently re-paying it for every user on a format change is not a
      // decision this code path should make on its own. The existing
      // POST /app/v1/documents/:id/analyze retry stays the explicit route.
      this.logger.log(
        `Document ${documentId}: index text re-derived; existing insights predate the change`,
      );
    }

    // analyzeAndStore returns stored rows when present (no LLM call), so
    // this also heals a missing analysis from a previously failed
    // best-effort run.
    const insights = await this.analyzeBestEffort(
      userId,
      documentId,
      input,
      indexText,
    );

    return {
      documentId,
      created: false,
      factsStored,
      deadlinesCreated,
      quality: this.quality.assess(input),
      insights,
      // The obligations are in scope here, and this is the only channel that
      // ever carries them to the client — they are not persisted server-side.
      // Returning [] meant a lost response plus a client retry (which lands
      // on this branch) silently cost the user every task suggestion, with
      // no way to recover them.
      suggestedTasks: input.obligations,
    };
  }

  private buildDeadlineRows(
    userId: string,
    documentId: string,
    input: AppDocumentIngestInput,
  ): Array<{
    userId: string;
    label: string;
    deadlineDate: Date;
    sourceType: string;
    sourceId: string;
  }> {
    const rows = input.deadlines.map((d) => ({
      userId,
      label: d.kind ? `${d.kind}: ${d.label}` : d.label,
      deadlineDate: new Date(`${d.date}T00:00:00.000Z`),
      sourceType: "document",
      sourceId: documentId,
    }));
    const kept = rows.filter((row) => this.isValidDeadlineDate(row.deadlineDate));
    if (kept.length < rows.length) {
      // The user is told through DocumentQualityService's "unusable_deadlines"
      // issue; this line is for whoever has to explain why a Frist is missing.
      this.logger.warn(
        `Document ${documentId}: dropped ${rows.length - kept.length} deadline(s) outside the ${MAX_FUTURE_DAYS}-day horizon`,
      );
    }
    return kept;
  }

  private async analyzeBestEffort(
    userId: string,
    documentId: string,
    input: AppDocumentIngestInput,
    indexText: string,
  ): Promise<AppInsightRecord[]> {
    const source: DocumentAnalysisSource = {
      title: input.title ?? input.fileName ?? documentId,
      category: input.category,
      docDate: input.docDate ?? null,
      indexText,
    };
    try {
      return await this.analysis.analyzeAndStore(
        userId,
        documentId,
        input.sourceHash,
        source,
      );
    } catch (err) {
      this.logger.warn(
        `Document analysis skipped for document ${documentId} (user ${userId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * Docvault index — best-effort: document, facts and deadlines are already
   * committed, so a search-index failure must not fail the whole ingest. It
   * only degrades retrieval until the client re-syncs. Tag links cascade on
   * document deletion via FK.
   */
  private async indexAndTag(
    userId: string,
    documentId: string,
    indexText: string,
    input: AppDocumentIngestInput,
  ): Promise<void> {
    try {
      await this.docvault.ingest({
        text: indexText,
        title: input.title ?? input.fileName ?? documentId,
        docvaultId: documentId,
        ownerUserId: userId,
        category: input.category,
      });
    } catch (err) {
      this.logger.error(
        `Docvault index failed for document ${documentId} (user ${userId}) — ingest continues without search index`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    const unique = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
    if (unique.length === 0) return;

    // createMany+skipDuplicates, then read back: `upsert` in a Promise.all
    // races itself on @@unique([userId, name]) — two documents batch-imported
    // with the same new tag both find nothing, both insert, and the loser gets
    // a P2002 that escapes indexAndTag, fails the whole ingest with a 500 and
    // costs the client a retry. createMany absorbs the race in the database.
    await this.prisma.documentTag.createMany({
      data: unique.map((name) => ({ userId, name })),
      skipDuplicates: true,
    });
    const tagRows = await this.prisma.documentTag.findMany({
      where: { userId, name: { in: unique } },
      select: { id: true },
    });

    await this.prisma.documentTagLink.createMany({
      data: tagRows.map((tag) => ({ documentId, tagId: tag.id })),
      skipDuplicates: true,
    });
  }


  async list(userId: string): Promise<AppDocumentListItem[]> {
    // No pagination on this legacy endpoint (the macOS client pages via
    // /sync): cap far above realistic personal volume and log truncation
    // instead of building an unbounded response.
    const LIST_MAX = 500;
    const [docs, links, insights] = await Promise.all([
      this.prisma.userDocument.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: LIST_MAX,
        select: {
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
        },
      }),
      this.prisma.documentTagLink.findMany({
        where: { document: { userId } },
        take: LIST_MAX * 10,
        select: {
          documentId: true,
          tag: { select: { id: true, name: true, color: true } },
        },
      }),
      this.analysis.listForUser(userId),
    ]);

    const tagsByDoc = new Map<
      string,
      { id: string; name: string; color: string | null }[]
    >();
    for (const link of links) {
      const list = tagsByDoc.get(link.documentId) ?? [];
      list.push(link.tag);
      tagsByDoc.set(link.documentId, list);
    }

    const insightsByDoc = new Map<string, AppInsightRecord[]>();
    for (const insight of insights) {
      const list = insightsByDoc.get(insight.documentId) ?? [];
      list.push(insight);
      insightsByDoc.set(insight.documentId, list);
    }
    if (docs.length === LIST_MAX) {
      this.logger.warn(
        `Document list for user ${userId} hit the ${LIST_MAX}-row cap — oldest rows omitted`,
      );
    }

    return docs.map((doc) => ({
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
      tags: tagsByDoc.get(doc.id) ?? [],
      insights: insightsByDoc.get(doc.id) ?? [],
    }));
  }

  /**
   * Deletes the document row (cascades to UserMemory + tag links), its
   * deadlines, and its docvault search chunks.
   */
  async delete(userId: string, documentId: string): Promise<boolean> {
    const deleted = await this.userMemory.deleteDocument(userId, documentId);
    if (!deleted) return false;

    try {
      await this.docvault.delete(documentId, userId);
    } catch (err) {
      this.logger.warn(
        `Docvault cleanup failed for document ${documentId} (user ${userId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  private async classifyExtraction(
    userId: string,
    input: AppDocumentIngestInput,
  ): Promise<InjectionVerdict> {
    const joined = [
      input.title,
      input.sender,
      input.summary,
      ...input.facts.map((f) => f.content),
      ...input.deadlines.map((d) => `${d.kind ?? ""} ${d.label}`),
      ...input.obligations,
      ...input.addresses.map((a) => `${a.purpose ?? ""} ${a.address}`),
      ...input.amounts.map((a) => `${a.label ?? ""} ${a.value}`),
      ...input.tags,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .slice(0, CLASSIFY_INPUT_MAX_CHARS);

    if (!joined) return "SAFE";

    try {
      return await this.injectionClassifier.classify(joined);
    } catch (err) {
      // Fail open, consistent with DocvaultService.query and the Telegram
      // preprocessor path: a classifier outage must not block legitimate use.
      // Retrieved content is additionally tagged as untrusted in every prompt.
      this.logger.warn(
        `Injection classifier unavailable for user ${userId} ingest — failing open: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "SAFE";
    }
  }

  /**
   * The sanitized index/search text. This — not the raw document — is what
   * UserDocument.fullText and the docvault LawChunk index receive.
   */
  private buildIndexText(input: AppDocumentIngestInput): string {
    const lines: string[] = [];
    if (input.title) lines.push(`Titel: ${input.title}`);
    if (input.sender) lines.push(`Absender: ${input.sender}`);
    if (input.docDate) lines.push(`Dokumentdatum: ${input.docDate}`);
    lines.push(`Kategorie: ${input.category}`);
    if (input.summary) lines.push(`Zusammenfassung: ${input.summary}`);

    if (input.facts.length > 0) {
      lines.push("Fakten:");
      for (const fact of input.facts) {
        lines.push(`- ${fact.content} (Wichtigkeit: ${fact.importance})`);
      }
    }
    // Pflichten are what the user must actively DO. They were previously
    // absent here, which meant they reached neither UserDocument.fullText
    // nor the docvault index nor DocumentAnalysisService (whose prompt is
    // built from this same string) — so the `next_step` insights were
    // generated without ever seeing the obligations the local model had
    // extracted. The incentive was backwards: an obligation filed correctly
    // under `obligations` was lost, while the same sentence left in `facts`
    // survived.
    if (input.obligations.length > 0) {
      lines.push("Pflichten:");
      for (const obligation of input.obligations) {
        lines.push(`- ${obligation}`);
      }
    }

    if (input.deadlines.length > 0) {
      lines.push("Fristen:");
      for (const d of input.deadlines) {
        lines.push(`- ${d.kind ? `${d.kind}: ` : ""}${d.label} (${d.date})`);
      }
    }
    if (input.addresses.length > 0) {
      lines.push("Adressen:");
      for (const a of input.addresses) {
        lines.push(`- ${a.purpose ? `${a.purpose}: ` : ""}${a.address}`);
      }
    }
    if (input.amounts.length > 0) {
      lines.push("Beträge:");
      for (const a of input.amounts) {
        lines.push(
          `- ${a.label ? `${a.label}: ` : ""}${a.value}${a.currency ? ` ${a.currency}` : ""}`,
        );
      }
    }

    return lines.join("\n").slice(0, INDEX_TEXT_MAX_CHARS);
  }

  private isValidDeadlineDate(date: Date): boolean {
    const now = new Date();
    const startOfToday = utcStartOfToday(now);
    const max = new Date(startOfToday);
    max.setUTCDate(max.getUTCDate() + MAX_FUTURE_DAYS);
    return date >= startOfToday && date <= max;
  }
}
