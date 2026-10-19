import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AppAuthGuard } from "./app-auth.guard";
import { IsoDate } from "./iso-date";
import { AppDocumentsService } from "./app-documents.service";
import { AppDocumentAskService } from "./app-document-ask.service";
import { DocumentAnalysisService } from "./document-analysis.service";
import { AppAuthedRequest } from "./app-api.types";

const DocumentAskSchema = z.object({
  question: z.string().min(1).max(4000),
  language: z.enum(["ru", "de", "en", "uk"]).optional(),
});

const DocumentIngestSchema = z.object({
  // SHA-256 of the raw file, computed on-device — dedup key + provenance
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, "must be sha256 hex"),
  fileName: z.string().min(1).max(255).optional(),
  title: z.string().min(1).max(300).optional(),
  sender: z.string().min(1).max(200).optional(),
  category: z.enum([
    "mietvertrag",
    "jobcenter",
    "bank",
    "visa",
    "versicherung",
    "other",
  ]),
  docDate: IsoDate.optional(),
  summary: z.string().min(1).max(2000).optional(),
  facts: z
    .array(
      z.object({
        content: z.string().min(1).max(1000),
        importance: z.enum(["high", "medium", "low"]).default("medium"),
      }),
    )
    .max(50)
    .default([]),
  deadlines: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        date: IsoDate,
        kind: z.string().min(1).max(60).optional(),
      }),
    )
    .max(20)
    .default([]),
  obligations: z.array(z.string().min(1).max(300)).max(20).default([]),
  addresses: z
    .array(
      z.object({
        purpose: z.string().min(1).max(100).optional(),
        address: z.string().min(1).max(300),
      }),
    )
    .max(10)
    .default([]),
  amounts: z
    .array(
      z.object({
        label: z.string().min(1).max(100).optional(),
        value: z.string().min(1).max(50),
        currency: z.string().min(1).max(10).optional(),
      }),
    )
    .max(20)
    .default([]),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
  isActive: z.boolean().default(true),
  expiryDate: IsoDate.optional(),
});

@Controller("app/v1/documents")
@UseGuards(AppAuthGuard)
export class AppDocumentsController {
  constructor(
    private readonly documents: AppDocumentsService,
    private readonly documentAsk: AppDocumentAskService,
    private readonly documentAnalysis: DocumentAnalysisService,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post()
  @HttpCode(201)
  async ingest(@Req() req: AppAuthedRequest, @Body() rawBody: unknown) {
    const parsed = DocumentIngestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.documents.ingest(req.appSession.userId, parsed.data);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(":id/ask")
  @HttpCode(200)
  async askDocument(
    @Req() req: AppAuthedRequest,
    @Param("id") documentId: string,
    @Body() rawBody: unknown,
  ): Promise<{ answer: string }> {
    const parsed = DocumentAskSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const answer = await this.documentAsk.ask(
      req.appSession.userId,
      documentId,
      parsed.data.question,
      parsed.data.language,
    );
    return { answer };
  }

  // Each call can spend one Sonnet analysis (~$0.02), so the throttle is
  // tighter than chat: it only ever runs when no insights are stored yet.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post(":id/analyze")
  @HttpCode(200)
  async analyzeDocument(
    @Req() req: AppAuthedRequest,
    @Param("id") documentId: string,
  ) {
    return this.documentAnalysis.analyzeStoredDocument(
      req.appSession.userId,
      documentId,
    );
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get()
  list(@Req() req: AppAuthedRequest) {
    return this.documents.list(req.appSession.userId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Delete(":id")
  async delete(@Req() req: AppAuthedRequest, @Param("id") documentId: string) {
    const deleted = await this.documents.delete(
      req.appSession.userId,
      documentId,
    );
    if (!deleted) {
      throw new BadRequestException("Document not found");
    }
    return { deleted: true };
  }
}
