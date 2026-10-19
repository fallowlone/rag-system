import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import {
  ConversationHistoryRead,
  ConversationMessage,
} from "../memory/memory.types";

const CONVERSATION_TTL_SECONDS = 86400;

/**
 * Keys examined per SCAN round trip. Judgement call, not a tuned number:
 * large enough that a user's handful of dated keys is usually found in one
 * or two passes, small enough that no single call stalls the shared Redis.
 */
const SCAN_BATCH = 100;

/**
 * Escapes the glob metacharacters Redis MATCH understands, so an id
 * interpolated into a pattern can only ever match itself.
 */
function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, (char) => `\\${char}`);
}

/**
 * Atomic append with in-script legacy-format migration. Before the list
 * migration, conv:{userId} held a single JSON-array string; RPUSH against
 * such a key raises WRONGTYPE. A client-side catch→DEL→retry is racy: two
 * concurrent callers can each run DEL, the second DEL wiping the first
 * caller's freshly-pushed message. Running type-check + reset + append as
 * one Lua script closes that window — Redis executes scripts atomically, so
 * the second caller always observes a list and simply appends.
 */
const CONVERSATION_APPEND_SCRIPT = `
if redis.call('TYPE', KEYS[1]).ok == 'string' then
  redis.call('DEL', KEYS[1])
end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('LLEN', KEYS[1])
`;

/**
 * Atomic read with the same legacy-format guard: a legacy string-typed key
 * is cleared and reported as empty in the same atomic step, so this
 * reader's cleanup DEL can never wipe a message concurrently appended by
 * the (equally atomic) append script.
 */
const CONVERSATION_READ_SCRIPT = `
if redis.call('TYPE', KEYS[1]).ok == 'string' then
  redis.call('DEL', KEYS[1])
  return {}
end
return redis.call('LRANGE', KEYS[1], 0, -1)
`;

/**
 * Atomic consume-and-stash (single EVAL, see CONSUME_AND_STASH_SCRIPT):
 * GETDELs the one-shot proposal key and, only when it held decodable JSON,
 * stashes the caller-supplied payload under the claim key with a TTL.
 * Crash between consume and stash is impossible — both happen inside the
 * script — so a restarted process never faces a burned code with no claim.
 * Concurrent callers: exactly one GETDEL wins; the loser observes null and
 * must compensate (e.g. revoke its mint).
 */
const CONSUME_AND_STASH_SCRIPT = `
local raw = redis.call('GETDEL', KEYS[1])
if not raw then return nil end
local ok, _ = pcall(cjson.decode, raw)
if not ok then return nil end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return raw
`;
/**
 * Atomic compare-and-consume (single EVAL, see CONSUME_IF_MATCH_SCRIPT):
 * returns the parsed JSON and deletes the key only when its `field`
 * equals `expected`. Concurrent matching callers: exactly one wins.
 * Mismatched callers observe null and the key survives for the rightful
 * owner. Missing/corrupt keys read as null without deleting.
 */
const CONSUME_IF_MATCH_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, obj = pcall(cjson.decode, raw)
if not ok or type(obj) ~= 'table' then return nil end
if obj[ARGV[2]] == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return raw
end
return nil
`;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly client: Redis;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is required");
    }
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    this.client.on("error", (err) => {
      this.logger.warn("Redis error: " + err.message);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log("Redis connected");
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, "EX", ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(
        `Corrupted cache value at "${key}", clearing: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.client.del(key);
      return null;
    }
  }

  /**
   * Batched JSON read: one pipelined MGET-style round trip instead of one
   * command per key. Missing/corrupted entries come back as null. Used by
   * the embedding cache, where a full-law ingest reads thousands of keys.
   */
  async getJsonMany<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return [];
    const raws = await this.client.mget(...keys);
    return raws.map((raw, i) => {
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch (err) {
        this.logger.warn(
          `Corrupted cache value at "${keys[i]}", clearing: ${err instanceof Error ? err.message : String(err)}`,
        );
        void this.client.del(keys[i]!).catch(() => undefined);
        return null;
      }
    });
  }

  /**
   * Batched JSON write: one pipelined round trip for the whole key set.
   * Chunks into 500-key groups to keep each pipeline payload bounded.
   * Per-command pipeline errors resolve inside exec()'s result (ioredis does
   * not reject the whole batch), so inspect them: an OOM/maxmemory eviction
   * halfway through would otherwise leave a silent hole in the cache. Warns
   * instead of throwing — a cache backfill must degrade to a miss, never
   * fail the ingest it serves.
   */
  async setJsonMany<T>(
    entries: Array<{ key: string; value: T }>,
    ttlSeconds: number,
  ): Promise<void> {
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      const pipeline = this.client.pipeline();
      for (const { key, value } of slice) {
        pipeline.set(key, JSON.stringify(value), "EX", ttlSeconds);
      }
      const results = await pipeline.exec();
      if (results) {
        for (let j = 0; j < results.length; j += 1) {
          const [err] = results[j]!;
          if (err) {
            this.logger.warn(
              `setJsonMany: command ${i + j} (${slice[j]!.key}) failed, continuing: ${err.message}`,
            );
          }
        }
      }
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  /**
   * JSON write that fails when the key already exists (SET ... NX) — first
   * writer wins. Returns true when this call stored the value, false when a
   * live key (e.g. another device's pairing proposal for the same code)
   * already holds the slot. The TTL bounds the slot so a stale key can never
   * wedge the namespace.
   */
  async setJsonNx<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.client.set(
      key,
      JSON.stringify(value),
      "EX",
      ttlSeconds,
      "NX",
    );
    return result === "OK";
  }

  /**
   * Atomic compare-and-consume (single EVAL, see CONSUME_IF_MATCH_SCRIPT):
   * returns the parsed JSON and deletes the key only when its `field`
   * equals `expected`. Concurrent matching callers: exactly one wins.
   * Mismatched callers observe null and the key survives for the rightful
   * owner. Missing/corrupt keys read as null without deleting.
   */
  async takeJsonIf<T>(
    key: string,
    field: string,
    expected: string,
  ): Promise<T | null> {
    const raw = (await this.client.eval(
      CONSUME_IF_MATCH_SCRIPT,
      1,
      key,
      expected,
      field,
    )) as string | null;
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Unreachable in practice — the script already decoded this payload —
      // but never let a corrupt claim surface as a token.
      return null;
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Deletes every key under `prefix`, returning how many were removed.
   *
   * SCAN, never KEYS: KEYS walks the whole keyspace in one blocking call on
   * a single-threaded server that is also carrying BullMQ and the live
   * conversation lists.
   *
   * The prefix is glob-escaped. Redis MATCH is a glob, so an id containing
   * `*`, `?`, `[`, `]` or `\` would silently widen the pattern — on a
   * GDPR erase path that means deleting another user's keys, so this is a
   * correctness requirement rather than hygiene.
   */
  async delByPrefix(prefix: string): Promise<number> {
    const pattern = `${escapeGlob(prefix)}*`;
    let cursor = "0";
    let removed = 0;
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_BATCH,
      );
      cursor = next;
      if (keys.length > 0) {
        removed += await this.client.del(...keys);
      }
    } while (cursor !== "0");
    return removed;
  }

  /**
   * Atomic read-then-delete (single GETDEL round trip) instead of a
   * separate GET + DEL — closes the TOCTOU window where a second caller's
   * GET could still observe the key between the first caller's GET and its
   * later DEL. Used for one-shot pending-state keys (e.g. letter_*_pending)
   * where a value must be consumed exactly once.
   */
  async getDelJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.getdel(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(
        `Corrupted cache value at "${key}" (already consumed by GETDEL): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Atomic consume-and-stash (single EVAL, see CONSUME_AND_STASH_SCRIPT):
   * consumes the one-shot `sourceKey` and stores `destValue` at `destKey`
   * in the same script invocation. Returns the consumed JSON, or null when
   * the source was missing/corrupt (the stash is skipped then).
   */
  async getDelAndSetJson<T>(
    sourceKey: string,
    destKey: string,
    destValue: unknown,
    ttlSeconds: number,
  ): Promise<T | null> {
    const raw = (await this.client.eval(
      CONSUME_AND_STASH_SCRIPT,
      2,
      sourceKey,
      destKey,
      JSON.stringify(destValue),
      String(ttlSeconds),
    )) as string | null;
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Unreachable in practice — the script only returns decodable payloads.
      return null;
    }
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  private static convKey(userId: string): string {
    return `conv:${userId}`;
  }

  /**
   * Reads full conversation history from the native Redis list at
   * `conv:{userId}`. Convenience wrapper over getConversationHistoryEntries
   * for callers that don't need the raw read count.
   */
  async getConversationHistory(userId: string): Promise<ConversationMessage[]> {
    const { messages } = await this.getConversationHistoryEntries(userId);
    return messages;
  }

  /**
   * Reads the conversation history and reports the raw number of list
   * entries consumed (readCount includes corrupted entries that were skipped
   * during parsing). collapseConversationHistory needs readCount to replace
   * exactly the prefix that was read.
   *
   * Legacy migration: a pre-list JSON-array-string key is atomically cleared
   * inside the read script (see CONVERSATION_READ_SCRIPT) and reported as an
   * empty history.
   */
  async getConversationHistoryEntries(
    userId: string,
  ): Promise<ConversationHistoryRead> {
    const convKey = CacheService.convKey(userId);
    const raw = (await this.client.eval(
      CONVERSATION_READ_SCRIPT,
      1,
      convKey,
    )) as string[];

    const messages: ConversationMessage[] = [];
    for (const item of raw) {
      try {
        messages.push(JSON.parse(item) as ConversationMessage);
      } catch (err) {
        this.logger.warn(
          `Corrupted conversation history entry at "${convKey}", skipping: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { messages, readCount: raw.length };
  }

  /**
   * Atomically appends a single message to the conversation history list
   * and refreshes the 24h TTL. Runs as one Lua script (see
   * CONVERSATION_APPEND_SCRIPT), so concurrent callers (main bot flow +
   * BullMQ document processor) can never lose each other's writes — neither
   * via the old GET-array→push→SET pattern nor via a racy legacy-key reset.
   */
  async appendConversationMessage(
    userId: string,
    message: ConversationMessage,
  ): Promise<void> {
    const convKey = CacheService.convKey(userId);
    await this.client.eval(
      CONVERSATION_APPEND_SCRIPT,
      1,
      convKey,
      JSON.stringify(message),
      String(CONVERSATION_TTL_SECONDS),
    );
  }

  /**
   * Collapses the first `readCount` history entries (the prefix a prior
   * getConversationHistoryEntries call returned) into `messages` — used
   * after summarization. Implemented as MULTI { LTRIM readCount..-1;
   * LPUSH reversed(messages); EXPIRE }: only the prefix that was actually
   * read is dropped, so entries appended concurrently between the read and
   * this collapse survive at the tail instead of being wiped by a full
   * DEL-and-rewrite. LPUSH prepends in reverse argument order, hence the
   * reversed payloads to keep `messages` in original order at the head.
   */
  async collapseConversationHistory(
    userId: string,
    messages: ConversationMessage[],
    readCount: number,
  ): Promise<void> {
    const convKey = CacheService.convKey(userId);
    const multi = this.client.multi();
    multi.ltrim(convKey, readCount, -1);
    if (messages.length > 0) {
      multi.lpush(
        convKey,
        ...[...messages].reverse().map((m) => JSON.stringify(m)),
      );
    }
    multi.expire(convKey, CONVERSATION_TTL_SECONDS);
    await multi.exec();
  }
}
