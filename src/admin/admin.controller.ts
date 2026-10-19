import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { Throttle } from "@nestjs/throttler";
import { IngestionService } from "../ingestion/ingestion.service";
import { RetrievalService } from "../rag/retrieval.service";
import { PrismaService } from "../prisma/prisma.service";
import { DebugSearchResult } from "../rag/rag.types";
import { DocvaultAuthGuard } from "./docvault-auth.guard";
import { AdminAuthGuard } from "./admin-auth.guard";
import { DocvaultService } from "../rag/docvault.service";
import { MemoryTranslationService } from "../memory/memory-translation.service";
import { fingerprint } from "../common/log-fingerprint";

const IngestBodySchema = z.object({
  text: z.string().min(100).max(200_000),
  title: z.string().min(1).max(200),
  source: z.literal("docvault"),
  docvaultId: z.string().min(1).max(200),
  ownerUserId: z.string().min(1).max(200),
  metadata: z
    .object({
      sender: z.string().optional(),
      documentDate: z.string().optional(),
      category: z.string().optional(),
    })
    .optional(),
});

const QueryBodySchema = z.object({
  question: z.string().min(1).max(4000),
  ownerUserId: z.string().min(1).max(200),
  docvaultId: z.string().max(200).optional(),
});

const OwnerQuerySchema = z.object({
  ownerUserId: z.string().min(1).max(200),
});

const DebugSearchQuerySchema = z.object({
  q: z.string().min(1).max(4000),
});

type IngestBody = z.infer<typeof IngestBodySchema>;
type QueryBody = z.infer<typeof QueryBodySchema>;

@Controller("admin")
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly ingestion: IngestionService,
    private readonly retrieval: RetrievalService,
    private readonly prisma: PrismaService,
    private readonly docvault: DocvaultService,
    private readonly memoryTranslation: MemoryTranslationService,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post("ingest")
  @HttpCode(202)
  @UseGuards(AdminAuthGuard)
  triggerIngest(): { message: string } {
    // 202 runs in the background: pre-check the service lock so a double
    // POST gets an honest 409 instead of a run that instantly fails inside
    // the fire-and-forget promise (the service re-checks as backstop).
    if (this.ingestion.ingestAllInProgress) {
      throw new ConflictException("Full ingestion already running");
    }
    void this.ingestion.ingestAll().catch((err: unknown) => {
      this.logger.error(
        "Background ingestAll failed",
        err instanceof Error ? err.stack : String(err),
      );
    });

    return { message: "Ingestion started in background" };
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post("ingest/:lawId")
  @HttpCode(202)
  @UseGuards(AdminAuthGuard)
  triggerIngestOne(@Param("lawId") lawId: string): { message: string } {
    if (this.ingestion.isLawInProgress(lawId)) {
      throw new ConflictException(`Ingestion of '${lawId}' already running`);
    }
    void this.ingestion.ingestLaw(lawId).catch((err: unknown) => {
      this.logger.error(
        `Background ingestLaw(${lawId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    });

    return { message: `Ingestion of '${lawId}' started in background` };
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Get("search")
  @UseGuards(AdminAuthGuard)
  async debugSearch(
    @Query("q") rawQuery: unknown,
  ): Promise<DebugSearchResult[]> {
    const parsed = DebugSearchQuerySchema.safeParse({ q: rawQuery });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const query = parsed.data.q;
    this.logger.debug(`Debug search: ${fingerprint(query)}`);
    return this.retrieval.debugSearch(query, 10);
  }

  /**
   * Linear conversation history for a user. Cursor-paginated by createdAt
   * (descending — newest first). Pass `?before=ISO_TIMESTAMP` to fetch the
   * next page; omit for the most recent batch.
   */
  @Get("history/:userId")
  @UseGuards(AdminAuthGuard)
  async userHistory(
    @Param("userId") userId: string,
    @Query("before") before?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{
    items: Array<{
      id: string;
      role: string;
      content: string;
      createdAt: string;
    }>;
    nextBefore: string | null;
  }> {
    if (!userId || userId.length > 64) {
      throw new BadRequestException("invalid userId");
    }

    const limit = Math.min(
      Math.max(Number.parseInt(limitRaw ?? "50", 10) || 50, 1),
      200,
    );

    const beforeDate = before ? new Date(before) : undefined;
    if (before && Number.isNaN(beforeDate?.getTime() ?? NaN)) {
      throw new BadRequestException("invalid before timestamp");
    }

    const rows = await this.prisma.conversationLog.findMany({
      where: {
        userId,
        ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, role: true, content: true, createdAt: true },
    });

    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.createdAt.toISOString(),
      })),
      nextBefore:
        rows.length === limit && last ? last.createdAt.toISOString() : null,
    };
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post("retranslate")
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  async retranslate(): Promise<{ updated: number; skipped: number }> {
    // Awaited (200), so the service lock's ConflictException propagates as
    // 409 directly — no controller pre-check needed.
    return this.memoryTranslation.retranslateAll();
  }

  // ── Docvault endpoints ────────────────────────────────────────────────────

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post("docvault/ingest")
  @HttpCode(200)
  @UseGuards(DocvaultAuthGuard)
  async docvaultIngest(
    @Body() rawBody: unknown,
  ): Promise<{ chunkCount: number; docvaultId: string }> {
    const parsed = IngestBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const body: IngestBody = parsed.data;

    return this.docvault.ingest({
      text: body.text,
      title: body.title,
      docvaultId: body.docvaultId,
      ownerUserId: body.ownerUserId,
      category: body.metadata?.category,
    });
  }

  @Get("docvault/status/:docvaultId")
  @UseGuards(DocvaultAuthGuard)
  async docvaultStatus(
    @Param("docvaultId") docvaultId: string,
    @Query("ownerUserId") ownerUserIdRaw?: string,
  ): Promise<{ ingested: boolean; chunkCount: number; docvaultId: string }> {
    const parsed = OwnerQuerySchema.safeParse({
      ownerUserId: ownerUserIdRaw,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.docvault.status(docvaultId, parsed.data.ownerUserId);
  }

  @Delete("docvault/:docvaultId")
  @UseGuards(DocvaultAuthGuard)
  async docvaultDelete(
    @Param("docvaultId") docvaultId: string,
    @Query("ownerUserId") ownerUserIdRaw?: string,
  ): Promise<{ deleted: number; docvaultId: string }> {
    const parsed = OwnerQuerySchema.safeParse({
      ownerUserId: ownerUserIdRaw,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.docvault.delete(docvaultId, parsed.data.ownerUserId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post("docvault/query")
  @HttpCode(200)
  @UseGuards(DocvaultAuthGuard)
  async docvaultQuery(@Body() rawBody: unknown): Promise<{ answer: string }> {
    const parsed = QueryBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const body: QueryBody = parsed.data;

    return this.docvault.query(body.question, body.ownerUserId, body.docvaultId);
  }
}
