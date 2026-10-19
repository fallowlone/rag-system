import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { CacheService } from "./cache.service";
import { ConversationMessage } from "../memory/memory.types";

jest.mock("ioredis");

interface FakeRedisClient {
  on: jest.Mock;
  connect: jest.Mock;
  quit: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  getdel: jest.Mock;
  eval: jest.Mock;
  expire: jest.Mock;
  multi: jest.Mock;
}

interface FakeMulti {
  del: jest.Mock;
  ltrim: jest.Mock;
  lpush: jest.Mock;
  expire: jest.Mock;
  exec: jest.Mock;
}

describe("CacheService conversation history (Redis list storage)", () => {
  const ORIGINAL_ENV = process.env;
  let fakeClient: FakeRedisClient;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, REDIS_URL: "redis://localhost:6379" };
    fakeClient = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      getdel: jest.fn(),
      eval: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
      multi: jest.fn(),
    };
    (Redis as unknown as jest.Mock).mockImplementation(() => fakeClient);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildService(): CacheService {
    return new CacheService();
  }

  function makeMultiMock(execResult: unknown[] = []): FakeMulti {
    return {
      del: jest.fn().mockReturnThis(),
      ltrim: jest.fn().mockReturnThis(),
      lpush: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(execResult),
    };
  }

  function msg(content: string, role: "user" | "assistant" = "user"): ConversationMessage {
    return { role, content, timestamp: 1 };
  }

  /**
   * Stateful in-memory Redis list emulating the semantics of the commands
   * the service issues (Lua append/read scripts, MULTI LTRIM/LPUSH). Used
   * by the interleaving tests where asserting call shapes alone is not
   * enough to prove concurrent appends survive a collapse.
   */
  function installFakeListStore(): { list: () => string[] } {
    let list: string[] = [];
    fakeClient.eval.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/require-await
      async (script: string, _numKeys: number, _key: string, ...args: string[]) => {
        if (script.includes("RPUSH")) {
          list = [...list, args[0]];
          return list.length;
        }
        return [...list];
      },
    );
    fakeClient.multi.mockImplementation(() => {
      const ops: Array<() => void> = [];
      const multi: Pick<FakeMulti, "ltrim" | "lpush" | "expire" | "exec"> = {
        ltrim: jest.fn((_key: string, start: number, _stop: number) => {
          ops.push(() => {
            list = list.slice(start);
          });
          return multi;
        }),
        lpush: jest.fn((_key: string, ...values: string[]) => {
          ops.push(() => {
            list = [...[...values].reverse(), ...list];
          });
          return multi;
        }),
        expire: jest.fn().mockReturnThis(),
        // eslint-disable-next-line @typescript-eslint/require-await
        exec: jest.fn(async () => {
          for (const op of ops) op();
          ops.length = 0;
          return [];
        }),
      };
      return multi;
    });
    return { list: () => list };
  }

  describe("appendConversationMessage", () => {
    it("appends via a single atomic Lua script (EVAL), never GET+SET", async () => {
      const cache = buildService();
      const message = msg("hi");

      await cache.appendConversationMessage("u1", message);

      expect(fakeClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("RPUSH"),
        1,
        "conv:u1",
        JSON.stringify(message),
        "86400",
      );
      expect(fakeClient.get).not.toHaveBeenCalled();
      expect(fakeClient.set).not.toHaveBeenCalled();
    });

    it("bundles legacy-key reset, append and TTL refresh into the one script (TYPE guard → DEL → RPUSH → EXPIRE)", async () => {
      // A client-side catch(WRONGTYPE)→DEL→retry is racy: a concurrent
      // caller's DEL can wipe this caller's fresh RPUSH. The whole sequence
      // must live inside one Lua script, which Redis executes atomically —
      // so we assert the atomic script shape rather than an interleaving.
      const cache = buildService();

      await cache.appendConversationMessage("u1", msg("hi"));

      const [script] = fakeClient.eval.mock.calls[0] as [string];
      expect(script).toContain("redis.call('TYPE', KEYS[1]).ok == 'string'");
      expect(script.indexOf("DEL")).toBeGreaterThan(-1);
      expect(script.indexOf("DEL")).toBeLessThan(script.indexOf("RPUSH"));
      expect(script).toContain("EXPIRE");
      // No separate client-side DEL/EXPIRE round trips outside the script.
      expect(fakeClient.del).not.toHaveBeenCalled();
      expect(fakeClient.expire).not.toHaveBeenCalled();
    });

    it("propagates Redis errors", async () => {
      const cache = buildService();
      fakeClient.eval.mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(
        cache.appendConversationMessage("u1", msg("hi")),
      ).rejects.toThrow("ECONNRESET");
    });
  });

  describe("getConversationHistory", () => {
    it("reads via the atomic Lua read script and parses each stored entry", async () => {
      const cache = buildService();
      const m1 = msg("a");
      const m2 = msg("b", "assistant");
      fakeClient.eval.mockResolvedValue([JSON.stringify(m1), JSON.stringify(m2)]);

      const history = await cache.getConversationHistory("u1");

      expect(fakeClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("LRANGE"),
        1,
        "conv:u1",
      );
      expect(history).toEqual([m1, m2]);
    });

    it("clears a legacy string-typed key inside the same atomic script that reads (TYPE guard → DEL → empty)", async () => {
      // Same rationale as the append script: a client-side cleanup DEL after
      // a WRONGTYPE error could wipe a message a concurrent (atomic) append
      // just wrote. Assert the guard lives inside the read script itself.
      const cache = buildService();

      await cache.getConversationHistory("u1");

      const [script] = fakeClient.eval.mock.calls[0] as [string];
      expect(script).toContain("redis.call('TYPE', KEYS[1]).ok == 'string'");
      expect(script.indexOf("DEL")).toBeGreaterThan(-1);
      expect(script.indexOf("DEL")).toBeLessThan(script.indexOf("LRANGE"));
      expect(fakeClient.del).not.toHaveBeenCalled();
    });

    it("skips corrupted entries but keeps the valid ones", async () => {
      const cache = buildService();
      const valid = msg("ok");
      fakeClient.eval.mockResolvedValue(["not-json{{", JSON.stringify(valid)]);

      const history = await cache.getConversationHistory("u1");

      expect(history).toEqual([valid]);
    });

    it("returns an empty array for a missing key", async () => {
      const cache = buildService();
      fakeClient.eval.mockResolvedValue([]);

      const history = await cache.getConversationHistory("u1");

      expect(history).toEqual([]);
    });
  });

  describe("getConversationHistoryEntries", () => {
    it("reports the raw readCount including corrupted entries that were skipped", async () => {
      const cache = buildService();
      const valid = msg("ok");
      fakeClient.eval.mockResolvedValue(["not-json{{", JSON.stringify(valid)]);

      const { messages, readCount } =
        await cache.getConversationHistoryEntries("u1");

      // readCount must reflect the raw list length so a later collapse
      // (LTRIM readCount) drops exactly the prefix that was read — including
      // corrupted entries — and nothing appended after it.
      expect(messages).toEqual([valid]);
      expect(readCount).toBe(2);
    });
  });

  describe("collapseConversationHistory", () => {
    it("trims only the read prefix and prepends the collapsed messages via MULTI (LTRIM + LPUSH + EXPIRE, no DEL)", async () => {
      const cache = buildService();
      const multiMock = makeMultiMock();
      fakeClient.multi.mockReturnValue(multiMock);
      const summary = [msg("s", "assistant")];

      await cache.collapseConversationHistory("u1", summary, 5);

      expect(fakeClient.multi).toHaveBeenCalled();
      expect(multiMock.ltrim).toHaveBeenCalledWith("conv:u1", 5, -1);
      expect(multiMock.lpush).toHaveBeenCalledWith(
        "conv:u1",
        JSON.stringify(summary[0]),
      );
      expect(multiMock.expire).toHaveBeenCalledWith("conv:u1", 86400);
      expect(multiMock.exec).toHaveBeenCalled();
      // A full DEL-and-rewrite would wipe concurrently appended entries.
      expect(multiMock.del).not.toHaveBeenCalled();
    });

    it("with an empty collapsed array still trims and refreshes TTL without LPUSH", async () => {
      const cache = buildService();
      const multiMock = makeMultiMock();
      fakeClient.multi.mockReturnValue(multiMock);

      await cache.collapseConversationHistory("u1", [], 3);

      expect(multiMock.ltrim).toHaveBeenCalledWith("conv:u1", 3, -1);
      expect(multiMock.lpush).not.toHaveBeenCalled();
      expect(multiMock.expire).toHaveBeenCalledWith("conv:u1", 86400);
    });

    it("preserves a message appended between the read and the collapse (regression: summarize-collapse lost concurrent appends)", async () => {
      const cache = buildService();
      installFakeListStore();

      await cache.appendConversationMessage("u1", msg("a"));
      await cache.appendConversationMessage("u1", msg("b"));
      const { readCount } = await cache.getConversationHistoryEntries("u1");

      // Concurrent writer (e.g. BullMQ document processor) lands after the
      // read but before the collapse — previously wiped by DEL+RPUSH.
      await cache.appendConversationMessage("u1", msg("c"));

      await cache.collapseConversationHistory("u1", [msg("S", "assistant")], readCount);

      const after = await cache.getConversationHistory("u1");
      expect(after.map((m) => m.content)).toEqual(["S", "c"]);
    });

    it("keeps multi-message collapse payloads in original order at the head", async () => {
      const cache = buildService();
      installFakeListStore();

      await cache.appendConversationMessage("u1", msg("a"));
      await cache.appendConversationMessage("u1", msg("b"));
      const { readCount } = await cache.getConversationHistoryEntries("u1");
      await cache.appendConversationMessage("u1", msg("tail"));

      await cache.collapseConversationHistory(
        "u1",
        [msg("S1", "assistant"), msg("S2", "assistant")],
        readCount,
      );

      const after = await cache.getConversationHistory("u1");
      expect(after.map((m) => m.content)).toEqual(["S1", "S2", "tail"]);
    });
  });
});

describe("CacheService.getDelJson (atomic GETDEL)", () => {
  const ORIGINAL_ENV = process.env;
  let fakeClient: FakeRedisClient;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, REDIS_URL: "redis://localhost:6379" };
    fakeClient = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      getdel: jest.fn(),
      eval: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
      multi: jest.fn(),
    };
    (Redis as unknown as jest.Mock).mockImplementation(() => fakeClient);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it("uses a single GETDEL call, not a separate GET + DEL", async () => {
    fakeClient.getdel.mockResolvedValue(JSON.stringify({ question: "q", answer: "a" }));
    const cache = new CacheService();

    const result = await cache.getDelJson<{ question: string; answer: string }>(
      "letter_style_pending:1",
    );

    expect(result).toEqual({ question: "q", answer: "a" });
    expect(fakeClient.getdel).toHaveBeenCalledWith("letter_style_pending:1");
    expect(fakeClient.get).not.toHaveBeenCalled();
    expect(fakeClient.del).not.toHaveBeenCalled();
  });

  it("returns null when the key is absent (already consumed by a concurrent caller)", async () => {
    fakeClient.getdel.mockResolvedValue(null);
    const cache = new CacheService();

    const result = await cache.getDelJson("letter_style_pending:1");

    expect(result).toBeNull();
  });

  it("returns null and does not throw on corrupted JSON — the key is already gone via GETDEL", async () => {
    fakeClient.getdel.mockResolvedValue("not-json{{");
    const cache = new CacheService();

    const result = await cache.getDelJson("letter_style_pending:1");

    expect(result).toBeNull();
    // Unlike getJson's corruption path, there is nothing left to clean up —
    // GETDEL already removed the key atomically as part of the read itself.
    expect(fakeClient.del).not.toHaveBeenCalled();
  });
});

describe("CacheService.setJsonNx + takeJsonIf (pairing slots and claims)", () => {
  const ORIGINAL_ENV = process.env;
  let fakeClient: FakeRedisClient;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, REDIS_URL: "redis://localhost:6379" };
    fakeClient = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      getdel: jest.fn(),
      eval: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
      multi: jest.fn(),
    };
    (Redis as unknown as jest.Mock).mockImplementation(() => fakeClient);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it("setJsonNx stores with SET ... NX and reports first-writer-wins", async () => {
    fakeClient.set.mockResolvedValue("OK");
    const cache = new CacheService();

    await expect(
      cache.setJsonNx("app_pair_device:1", { a: 1 }, 60),
    ).resolves.toBe(true);
    expect(fakeClient.set).toHaveBeenCalledWith(
      "app_pair_device:1",
      JSON.stringify({ a: 1 }),
      "EX",
      60,
      "NX",
    );

    fakeClient.set.mockResolvedValue(null);
    await expect(
      cache.setJsonNx("app_pair_device:1", { a: 2 }, 60),
    ).resolves.toBe(false);
  });

  it("takeJsonIf consumes via one atomic Lua script, never GET + DEL", async () => {
    const stored = JSON.stringify({ token: "t", secretHash: "h" });
    fakeClient.eval.mockResolvedValue(stored);
    const cache = new CacheService();

    const result = await cache.takeJsonIf<{ token: string }>(
      "app_pair_claim:1",
      "secretHash",
      "h",
    );

    expect(result).toEqual({ token: "t", secretHash: "h" });
    expect(fakeClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("cjson"),
      1,
      "app_pair_claim:1",
      "h",
      "secretHash",
    );
    // Any client-side GET/GETDEL/DEL round trip would reopen the
    // double-consume window the script exists to close.
    expect(fakeClient.get).not.toHaveBeenCalled();
    expect(fakeClient.getdel).not.toHaveBeenCalled();
    expect(fakeClient.del).not.toHaveBeenCalled();
  });

  it("takeJsonIf deletes only on match — the script guards DEL behind the field compare", async () => {
    const cache = new CacheService();
    await cache.takeJsonIf("k", "secretHash", "h");

    const [script] = fakeClient.eval.mock.calls[0] as [string];
    expect(script).toContain("redis.call('GET', KEYS[1])");
    expect(script).toContain("ARGV[1]");
    expect(script).toContain("ARGV[2]");
    // Exactly one DEL, positioned after the compare (not a blind consume).
    expect(script.match(/redis\.call\('DEL'/g)).toHaveLength(1);
    expect(script.indexOf("DEL")).toBeGreaterThan(script.indexOf("ARGV[2]"));
  });

  it("takeJsonIf reads a missing key as null", async () => {
    fakeClient.eval.mockResolvedValue(null);
    const cache = new CacheService();

    await expect(cache.takeJsonIf("k", "secretHash", "h")).resolves.toBeNull();
  });

  it("takeJsonIf propagates Redis errors", async () => {
    const cache = new CacheService();
    fakeClient.eval.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(cache.takeJsonIf("k", "secretHash", "h")).rejects.toThrow(
      "ECONNRESET",
    );
  });

  it("getDelAndSetJson consumes and stashes in a single script invocation", async () => {
    fakeClient.eval.mockResolvedValue(JSON.stringify({ deviceName: "Mac" }));
    const cache = new CacheService();

    const consumed = await cache.getDelAndSetJson<{ deviceName: string }>(
      "app_pair_device:1",
      "app_pair_claim:1",
      { token: "t" },
      60,
    );

    expect(consumed).toEqual({ deviceName: "Mac" });
    const [script, numKeys, src, dst, value, ttl] =
      fakeClient.eval.mock.calls[0] as [string, number, string, string, string, string];
    expect(script).toContain("GETDEL");
    expect(script).toContain("cjson.decode");
    expect(numKeys).toBe(2);
    expect(src).toBe("app_pair_device:1");
    expect(dst).toBe("app_pair_claim:1");
    expect(JSON.parse(value)).toEqual({ token: "t" });
    expect(ttl).toBe("60");
  });

  it("getDelAndSetJson reads a missing proposal as null", async () => {
    fakeClient.eval.mockResolvedValue(null);
    const cache = new CacheService();

    await expect(
      cache.getDelAndSetJson("app_pair_device:1", "app_pair_claim:1", {}, 60),
    ).resolves.toBeNull();
  });
});

describe("CacheService.setJsonMany pipeline errors", () => {
  const ORIGINAL_ENV = process.env;
  let fakeClient: FakeRedisClient & { pipeline: jest.Mock };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, REDIS_URL: "redis://localhost:6379" };
    fakeClient = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      getdel: jest.fn(),
      eval: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
      multi: jest.fn(),
      pipeline: jest.fn(),
    };
    (Redis as unknown as jest.Mock).mockImplementation(() => fakeClient);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function pipelineWith(execResult: Array<[Error | null, unknown]>) {
    const set = jest.fn().mockReturnThis();
    const exec = jest.fn().mockResolvedValue(execResult);
    fakeClient.pipeline.mockReturnValue({ set, exec });
    return { set, exec };
  }

  it("writes the whole batch through one pipeline per 500-key chunk", async () => {
    const { exec } = pipelineWith([[null, "OK"]]);
    const cache = new CacheService();

    await cache.setJsonMany(
      [{ key: "a", value: 1 }],
      60,
    );

    expect(fakeClient.pipeline).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("surfaces a per-command pipeline failure as a warning instead of a silent hole", async () => {
    const { exec } = pipelineWith([
      [null, "OK"],
      [new Error("OOM command not allowed"), null],
    ]);
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const cache = new CacheService();

    // Must not throw (cache backfill degrades to a miss) — but the failure
    // must be observable through the service Logger.
    await expect(
      cache.setJsonMany(
        [
          { key: "a", value: 1 },
          { key: "b", value: 2 },
        ],
        60,
      ),
    ).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("b"));
  });

  it("chunks writes larger than 500 keys into multiple pipelines", async () => {
    const { exec } = pipelineWith([[null, "OK"]]);
    const cache = new CacheService();
    const entries = Array.from({ length: 501 }, (_, i) => ({
      key: `k${i}`,
      value: i,
    }));

    await cache.setJsonMany(entries, 60);

    expect(fakeClient.pipeline).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("CacheService.delByPrefix", () => {
  const ORIGINAL_ENV = process.env;

  function buildClient(pages: Array<[string, string[]]>) {
    const scan = jest.fn();
    for (const page of pages) scan.mockResolvedValueOnce(page);
    return {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      scan,
      del: jest.fn().mockImplementation((...keys: string[]) => keys.length),
    };
  }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, REDIS_URL: "redis://localhost:6379" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it("walks every SCAN page and deletes what it finds", async () => {
    const client = buildClient([
      ["17", ["batchsum:u1:a", "batchsum:u1:b"]],
      ["0", ["batchsum:u1:c"]],
    ]);
    (Redis as unknown as jest.Mock).mockImplementation(() => client);

    const removed = await new CacheService().delByPrefix("batchsum:u1:");

    // A single-pass implementation would stop at the non-zero cursor and
    // silently leave the remaining keys behind.
    expect(client.scan).toHaveBeenCalledTimes(2);
    expect(removed).toBe(3);
  });

  it("uses SCAN, never KEYS", async () => {
    const client = buildClient([["0", []]]) as Record<string, unknown>;
    // KEYS walks the whole keyspace in one blocking call on a server that is
    // also carrying BullMQ and the live conversation lists.
    client.keys = jest.fn();
    (Redis as unknown as jest.Mock).mockImplementation(() => client);

    await new CacheService().delByPrefix("batchsum:u1:");

    expect(client.keys).not.toHaveBeenCalled();
    expect(client.scan).toHaveBeenCalled();
  });

  it("escapes glob metacharacters so one id cannot match another", async () => {
    const client = buildClient([["0", []]]);
    (Redis as unknown as jest.Mock).mockImplementation(() => client);

    await new CacheService().delByPrefix("batchsum:u*1:");

    // Unescaped, `u*1` would match u-anything-1 — on an erase path that
    // deletes another user's cached conversation summaries.
    expect(client.scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "batchsum:u\\*1:*",
      "COUNT",
      expect.any(Number),
    );
  });

  it("issues no DEL when a page comes back empty", async () => {
    const client = buildClient([["0", []]]);
    (Redis as unknown as jest.Mock).mockImplementation(() => client);

    const removed = await new CacheService().delByPrefix("batchsum:u1:");

    // `del()` with zero arguments is a Redis wrong-arity error, not a no-op.
    expect(client.del).not.toHaveBeenCalled();
    expect(removed).toBe(0);
  });
});
