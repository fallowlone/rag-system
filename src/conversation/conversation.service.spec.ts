import Anthropic from "@anthropic-ai/sdk";
import { ConversationService } from "./conversation.service";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMessage } from "../memory/memory.types";

jest.mock("@anthropic-ai/sdk");

describe("ConversationService.addMessage", () => {
  const ORIGINAL_ENV = process.env;
  let createMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
    createMock = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { create: createMock },
    }));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildPrisma(): PrismaService {
    return {
      conversationLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
  }

  /**
   * A minimal in-memory stand-in for CacheService's Redis-list-backed
   * conversation history. `appendConversationMessage` mutates the shared
   * store synchronously (mirroring Redis RPUSH being a single atomic
   * command), after a microtask hop to emulate real network I/O and force
   * concurrent callers to interleave.
   */
  function buildFakeCache(): {
    cache: CacheService;
    getStore: () => ConversationMessage[];
  } {
    let store: ConversationMessage[] = [];
    const cache = {
      appendConversationMessage: jest.fn(
        async (_userId: string, message: ConversationMessage) => {
          await Promise.resolve();
          store = [...store, message];
        },
      ),
      getConversationHistory: jest.fn(() => Promise.resolve([...store])),
      getConversationHistoryEntries: jest.fn(() =>
        Promise.resolve({ messages: [...store], readCount: store.length }),
      ),
      // Mirrors CacheService.collapseConversationHistory (MULTI LTRIM+LPUSH):
      // replaces only the `readCount` prefix that was read, preserving any
      // concurrently appended tail.
      collapseConversationHistory: jest.fn(
        (_userId: string, messages: ConversationMessage[], readCount: number) => {
          store = [...messages, ...store.slice(readCount)];
          return Promise.resolve();
        },
      ),
      del: jest.fn().mockResolvedValue(undefined),
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
      // First-wins summarize lock (mirrors CacheService.setJsonNx):
      // exactly one overlapping summarize proceeds, the loser skips.
      setJsonNx: jest.fn().mockResolvedValue(true),
    } as unknown as CacheService;
    return { cache, getStore: () => store };
  }

  it("appends via the atomic cache API, not a GET-array→push→SET round trip", async () => {
    const { cache } = buildFakeCache();
    const service = new ConversationService(cache, buildPrisma());

    await service.addMessage("u1", "user", "hello");

    expect(cache.appendConversationMessage).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ role: "user", content: "hello" }),
    );
    // Below the summarization threshold: no collapse should happen.
    expect(cache.collapseConversationHistory).not.toHaveBeenCalled();
  });

  it("concurrent addMessage calls for the same user never lose messages", async () => {
    const { cache, getStore } = buildFakeCache();
    const service = new ConversationService(cache, buildPrisma());

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.addMessage("u1", i % 2 === 0 ? "user" : "assistant", `msg-${i}`),
      ),
    );

    expect(getStore()).toHaveLength(20);
    const contents = getStore().map((m) => m.content).sort();
    const expected = Array.from({ length: 20 }, (_, i) => `msg-${i}`).sort();
    expect(contents).toEqual(expected);
  });

  it("summarizes and replaces history once the token estimate exceeds the threshold", async () => {
    const { cache } = buildFakeCache();
    const service = new ConversationService(cache, buildPrisma());

    // estimateTokens = ceil(len/4); 15000 chars => ~3750 tokens > SUMMARY_THRESHOLD (3000)
    const longContent = "a".repeat(15000);

    await service.addMessage("u1", "user", longContent);

    expect(createMock).toHaveBeenCalled();
    // Collapse must be scoped to the read prefix (readCount = 1 message
    // read), not a blanket replace of whatever is in the list by then.
    expect(cache.collapseConversationHistory).toHaveBeenCalledWith(
      "u1",
      [
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("summary text"),
        }),
      ],
      1,
    );
  });

  it("a message appended while summarization is in flight survives the collapse", async () => {
    const { cache, getStore } = buildFakeCache();
    // Deferred LLM response: summarize() stays in flight until we resolve it.
    let resolveSummary!: (value: unknown) => void;
    createMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSummary = resolve;
      }),
    );
    const service = new ConversationService(cache, buildPrisma());

    const longContent = "a".repeat(15000);
    const inFlight = service.addMessage("u1", "user", longContent);
    // Let addMessage progress through append + read and into summarize().
    await new Promise((resolve) => setImmediate(resolve));
    expect(createMock).toHaveBeenCalled();

    // Concurrent writer (BullMQ document processor) appends mid-summarization.
    await cache.appendConversationMessage("u1", {
      role: "assistant",
      content: "concurrent doc message",
      timestamp: Date.now(),
    });

    resolveSummary({
      content: [{ type: "text", text: "summary text" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await inFlight;

    // Collapse was scoped to the 1 message read before summarization…
    expect(cache.collapseConversationHistory).toHaveBeenCalledWith(
      "u1",
      expect.any(Array),
      1,
    );
    // …so the concurrently appended message survives at the tail.
    const contents = getStore().map((m) => m.content);
    expect(contents).toHaveLength(2);
    expect(contents[0]).toContain("summary text");
    expect(contents[1]).toBe("concurrent doc message");
  });

  it("overlapping summarizes serialize: the loser skips instead of wiping history", async () => {
    // Regression: two concurrent addMessage calls above threshold collapsed
    // with stale readCounts — the loser's LTRIM wiped the winner's list.
    // The first-wins sumlock makes the loser skip its summarize; both
    // appends still land.
    const { cache, getStore } = buildFakeCache();
    (cache.setJsonNx as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    // Deferred LLM response: the winner's summarize stays in flight while
    // the loser appends and reads.
    let resolveSummary!: (value: unknown) => void;
    createMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSummary = resolve;
      }),
    );
    const service = new ConversationService(cache, buildPrisma());

    const longContent = "a".repeat(15000);
    const first = service.addMessage("u1", "user", longContent);
    // Let the winner progress through append + read + lock into summarize().
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(createMock).toHaveBeenCalledTimes(1);

    const second = service.addMessage("u1", "user", longContent);
    resolveSummary({
      content: [{ type: "text", text: "summary text" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await Promise.all([first, second]);

    // Exactly one summarize→collapse ran; the lock was acquired twice,
    // released once (by the winner).
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(cache.collapseConversationHistory).toHaveBeenCalledTimes(1);
    expect(cache.collapseConversationHistory).toHaveBeenCalledWith(
      "u1",
      expect.any(Array),
      1,
    );
    expect(cache.del).toHaveBeenCalledWith("sumlock:u1");
    // The winner's summary plus the loser's message both survived.
    const contents = getStore().map((m) => m.content);
    expect(contents).toHaveLength(2);
    expect(contents[0]).toContain("summary text");
    expect(contents[1]).toBe(longContent);
  });

  it("does not summarize when the token estimate stays under the threshold", async () => {
    const { cache } = buildFakeCache();
    const service = new ConversationService(cache, buildPrisma());

    await service.addMessage("u1", "user", "short message");

    expect(createMock).not.toHaveBeenCalled();
    expect(cache.collapseConversationHistory).not.toHaveBeenCalled();
  });

  it("skips a stale collapse (and keeps the foreign lock) when the lock was lost mid-summarize", async () => {
    const { cache, getStore } = buildFakeCache();
    // The lock expired mid-summarize and a concurrent winner already holds
    // it with its own token: our readCount is stale, collapsing would wipe
    // the winner's summary.
    (cache.getJson as jest.Mock).mockResolvedValue({ token: "foreign-token" });
    const service = new ConversationService(cache, buildPrisma());

    await service.addMessage("u1", "user", "a".repeat(15000));

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(cache.collapseConversationHistory).not.toHaveBeenCalled();
    // Not our lock — must not delete it.
    expect(cache.del).not.toHaveBeenCalledWith("sumlock:u1");
    // The original message is still there, uncollapsed.
    expect(getStore()).toHaveLength(1);
  });

  it("re-acquires an expired-but-uncontended lock and collapses normally", async () => {
    const { cache } = buildFakeCache();
    // Lock expired with no contender: getJson misses, the NX re-acquire wins.
    (cache.getJson as jest.Mock).mockResolvedValue(null);
    const service = new ConversationService(cache, buildPrisma());

    await service.addMessage("u1", "user", "a".repeat(15000));

    // Acquire + retake.
    expect(cache.setJsonNx).toHaveBeenCalledTimes(2);
    expect(cache.setJsonNx).toHaveBeenLastCalledWith(
      "sumlock:u1",
      expect.objectContaining({ token: expect.any(String) }),
      180,
    );
    expect(cache.collapseConversationHistory).toHaveBeenCalledTimes(1);
    expect(cache.del).toHaveBeenCalledWith("sumlock:u1");
  });

  it("refreshes its own lock instead of re-acquiring when it still owns it", async () => {
    const { cache } = buildFakeCache();
    // getJson echoes back whatever token the latest setJsonNx stored —
    // i.e. we still own the lock when the slow summarize finishes.
    (cache.getJson as jest.Mock).mockImplementation(() => {
      const nxCalls = (cache.setJsonNx as jest.Mock).mock.calls;
      const last = nxCalls[nxCalls.length - 1]![1] as { token: string };
      return Promise.resolve({ token: last.token });
    });
    const service = new ConversationService(cache, buildPrisma());

    await service.addMessage("u1", "user", "a".repeat(15000));

    expect(cache.setJson).toHaveBeenCalledWith(
      "sumlock:u1",
      expect.objectContaining({ token: expect.any(String) }),
      180,
    );
    expect(cache.collapseConversationHistory).toHaveBeenCalledTimes(1);
  });

  it("logs the message to the durable conversationLog table", async () => {
    const { cache } = buildFakeCache();
    const prisma = buildPrisma();
    const service = new ConversationService(cache, prisma);

    await service.addMessage("u1", "assistant", "reply");

    expect(prisma.conversationLog.create).toHaveBeenCalledWith({
      data: { userId: "u1", role: "assistant", content: "reply" },
    });
  });
});

describe("ConversationService.clearHistory", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it("deletes the conv:{userId} key (preserves the forgetAll/GDPR contract)", async () => {
    const cache = { del: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService;
    const prisma = {} as PrismaService;
    const service = new ConversationService(cache, prisma);

    await service.clearHistory("u1");

    expect(cache.del).toHaveBeenCalledWith("conv:u1");
  });
});
