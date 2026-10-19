import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { EmbeddingProvider } from "./ingestion.types";
import {
  LOCAL_EMBEDDING_PROVIDER_ID,
  LOCAL_RETRIEVAL_DEFAULT_URL,
} from "../config/local-retrieval.constants";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_SIZE = 32;
// In-flight batch limit: ingest used to run its batches strictly serially,
// which made a full-law embed thousands of sequential HTTP round trips.
//
// MUST NOT exceed the retrieval service's admission limit
// (MAX_ADMITTED_REQUESTS, default 4 in services/retrieval-models/app/main.py).
// That semaphore is non-blocking: everything above the limit is answered with
// an immediate 503, so a higher number here does not buy throughput — it
// manufactures rejections. At 6 the two surplus batches were rejected on
// every ingest wave, and a batch that lost the race three times in a row threw:
// on the app path `indexAndTag` swallows that as best-effort, so the document
// was stored with NO search index and nobody was told.
const DEFAULT_BATCH_CONCURRENCY = 4;
const EMBEDDING_DIMENSION = 1024;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

const EmbedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number()).length(EMBEDDING_DIMENSION)),
});

@Injectable()
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = LOCAL_EMBEDDING_PROVIDER_ID;

  private readonly logger = new Logger(LocalEmbeddingProvider.name);
  private readonly baseUrl = normalizeBaseUrl(
    process.env.LOCAL_RETRIEVAL_URL ?? LOCAL_RETRIEVAL_DEFAULT_URL,
  );
  private readonly timeoutMs = parseTimeout(
    process.env.LOCAL_RETRIEVAL_TIMEOUT_MS,
  );
  private readonly batchSize = parseBatchSize(
    process.env.LOCAL_RETRIEVAL_BATCH_SIZE,
  );
  private readonly batchConcurrency = parseBatchConcurrency(
    process.env.LOCAL_EMBEDDING_BATCH_CONCURRENCY,
  );

  async embed(texts: string[]): Promise<number[][]> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    // Fire up to `batchConcurrency` batches at once; Promise.all over the
    // mapped slices preserves the original chunk order regardless of which
    // batch resolves first.
    const results = await mapWithConcurrency(
      batches,
      this.batchConcurrency,
      (batch) => this.embedBatchWithRetry(batch),
    );

    return results.flat();
  }

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ texts }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new RetryableHttpError(
            response.status,
            retryAfterMs(response.headers.get("retry-after")),
          );
        }

        const parsed = EmbedResponseSchema.parse(await response.json());
        if (parsed.embeddings.length !== texts.length) {
          throw new Error(
            `local embedding service returned ${parsed.embeddings.length} vectors for ${texts.length} texts`,
          );
        }
        return parsed.embeddings;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES) break;
        // A 503 from the admission semaphore is saturation, not a fault: the
        // service tells us when to come back, and its own inference takes
        // seconds, so the exponential ladder (500ms/1s) is usually too eager.
        const delay =
          err instanceof RetryableHttpError && err.retryAfterMs !== null
            ? Math.max(err.retryAfterMs, BASE_DELAY_MS)
            : BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Local embedding attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }
}

/**
 * HTTP failure that carries the origin's own retry hint. Saturation (503 from
 * the retrieval service's admission semaphore) is the case that matters: it
 * says "come back in N seconds" and the client used to ignore it.
 */
class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
    this.name = "RetryableHttpError";
  }
}

/** Retry-After in delta-seconds. Ignores the HTTP-date form (never sent here). */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  // Cap: a hostile or misconfigured header must not park ingest for minutes.
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

function parseBatchSize(value: string | undefined): number {
  if (!value) return DEFAULT_BATCH_SIZE;
  const parsed = Number(value);
  // Capped at 32 — the server rejects larger /embed batches (422): an
  // oversized request holds the global inference lock past the timeout and
  // stalls chat recall behind ingest traffic.
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 32
    ? parsed
    : DEFAULT_BATCH_SIZE;
}

function parseBatchConcurrency(value: string | undefined): number {
  if (!value) return DEFAULT_BATCH_CONCURRENCY;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 16
    ? parsed
    : DEFAULT_BATCH_CONCURRENCY;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
