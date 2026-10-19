import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { RerankingProvider, RerankingResult } from "./rag.types";
import {
  LOCAL_RERANKING_PROVIDER_ID,
  LOCAL_RETRIEVAL_DEFAULT_URL,
} from "../config/local-retrieval.constants";

const DEFAULT_TIMEOUT_MS = 10_000;

const RerankResponseSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      score: z.number(),
    }),
  ),
});

@Injectable()
export class LocalRerankingProvider implements RerankingProvider {
  readonly id = LOCAL_RERANKING_PROVIDER_ID;

  private readonly baseUrl = normalizeBaseUrl(
    process.env.LOCAL_RETRIEVAL_URL ?? LOCAL_RETRIEVAL_DEFAULT_URL,
  );
  private readonly timeoutMs = parseTimeout(
    process.env.LOCAL_RETRIEVAL_TIMEOUT_MS,
  );

  async rerank(
    query: string,
    documents: string[],
    topK: number,
  ): Promise<RerankingResult[]> {
    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, documents, topK }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // 503 is the retrieval service's admission semaphore, not a fault. It
      // carries Retry-After; RetrievalService.rerankWithRetry reads it off the
      // error rather than running its own fixed ladder into a busy service.
      throw new RetrievalHttpError(
        response.status,
        retryAfterMs(response.headers.get("retry-after")),
      );
    }

    return RerankResponseSchema.parse(await response.json()).results;
  }
}

/** HTTP failure carrying the origin's retry hint (see the embedding provider). */
export class RetrievalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
    this.name = "RetrievalHttpError";
  }
}

/** Retry-After in delta-seconds, capped so a bad header cannot park a request. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, 10) * 1000;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
