import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { CacheService } from "../cache/cache.service";
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from "./ingestion.types";

const EMBEDDING_TTL_SECONDS = 86_400; // 24 hours

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  // Single-flight dedup: while an embed() call for an exact text list is in
  // flight, a concurrent identical call awaits the same promise instead of
  // issuing a duplicate provider round trip. Concretely: recall and
  // recallDiary embed the identical query on every chat message and both
  // used to miss the cache before either write landed — two provider calls
  // per message for one vector.
  private readonly inFlight = new Map<string, Promise<number[][]>>();

  constructor(
    private readonly cache: CacheService,
    @Inject(EMBEDDING_PROVIDER)
    private readonly provider: EmbeddingProvider,
  ) {}

  /**
   * Embeds texts through the configured provider.
   * Redis cache keys include the provider id so vectors from different models
   * can never be mixed during a provider migration.
   */
  async embed(texts: string[]): Promise<number[][]> {
    // Dedup key covers the whole request: two callers with the same texts
    // share one cache read + provider call + cache backfill. Requests with
    // different text sets (e.g. a 3k-chunk law vs a 1-text recall) never
    // collide, and batch shape is preserved for the provider.
    const dedupKey = createHash("sha256")
      .update(`${this.provider.id}\0${texts.length}\0${texts.join("\0")}`)
      .digest("hex");

    const existing = this.inFlight.get(dedupKey);
    if (existing) return existing;

    const promise = this.embedUncached(texts).finally(() =>
      this.inFlight.delete(dedupKey),
    );
    this.inFlight.set(dedupKey, promise);
    return promise;
  }

  private async embedUncached(texts: string[]): Promise<number[][]> {
    const keys = texts.map((text) => embeddingCacheKey(this.provider.id, text));

    const cached = await this.cache.getJsonMany<number[]>(keys);
    const results: (number[] | null)[] = cached;
    const uncachedIndices: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (results[i] === null) uncachedIndices.push(i);
    }

    if (uncachedIndices.length === 0) {
      this.logger.debug(`embed: all ${texts.length} texts served from cache`);
      return results as number[][];
    }

    this.logger.debug(
      `embed: ${uncachedIndices.length}/${texts.length} texts need provider ${this.provider.id}`,
    );

    const uncachedTexts = uncachedIndices.map((i) => texts[i]!);
    const freshVectors = await this.provider.embed(uncachedTexts);
    if (freshVectors.length !== uncachedTexts.length) {
      throw new Error(
        `Embedding provider ${this.provider.id} returned ${freshVectors.length} vectors for ${uncachedTexts.length} texts`,
      );
    }

    const backfill: Array<{ key: string; value: number[] }> = [];
    for (let j = 0; j < uncachedIndices.length; j++) {
      const originalIndex = uncachedIndices[j]!;
      const vector = freshVectors[j]!;
      results[originalIndex] = vector;
      backfill.push({ key: keys[originalIndex]!, value: vector });
    }
    await this.cache.setJsonMany(backfill, EMBEDDING_TTL_SECONDS);

    return results as number[][];
  }
}

function embeddingCacheKey(providerId: string, text: string): string {
  return (
    "emb:" +
    createHash("sha256").update(`${providerId}\0${text}`).digest("hex")
  );
}
