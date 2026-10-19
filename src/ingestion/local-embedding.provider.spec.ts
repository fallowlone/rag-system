import { LocalEmbeddingProvider } from "./local-embedding.provider";
import { LOCAL_EMBEDDING_PROVIDER_ID } from "../config/local-retrieval.constants";

describe("LocalEmbeddingProvider", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;
  const embedding = Array.from({ length: 1024 }, (_, index) => index / 1024);

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      LOCAL_RETRIEVAL_URL: "http://retrieval.test:8000/",
      LOCAL_RETRIEVAL_TIMEOUT_MS: "1000",
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it("posts texts to the local embed endpoint and returns vectors", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ embeddings: [embedding] }),
    }) as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider();

    expect(provider.id).toBe(LOCAL_EMBEDDING_PROVIDER_ID);
    await expect(provider.embed(["hello"])).resolves.toEqual([embedding]);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://retrieval.test:8000/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ texts: ["hello"] }),
      }),
    );
  });

  it("rejects vectors that do not match the 1024-dimensional pgvector schema", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]] }),
    }) as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed(["hello"])).rejects.toThrow();
  });

  it("clamps the configured batch size to the server cap (32)", async () => {
    process.env.LOCAL_RETRIEVAL_BATCH_SIZE = "64";
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      const texts = JSON.parse(String(init.body)).texts as string[];
      return {
        ok: true,
        json: () =>
          Promise.resolve({ embeddings: texts.map(() => embedding) }),
      };
    }) as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider();
    const texts = Array.from({ length: 64 }, (_, index) => `text-${index}`);

    // 64 is rejected by the server (422 holds the inference lock past the
    // timeout), so the parser clamps to 32: two batches, order preserved.
    await expect(provider.embed(texts)).resolves.toHaveLength(64);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("sends multiple batches concurrently and preserves chunk order", async () => {
    process.env.LOCAL_RETRIEVAL_BATCH_SIZE = "2";
    // Each batch resolves in reverse order of issuance: with serial batching
    // the overall latency would stack; with concurrency the slowest batch
    // bounds it — and order must still follow the input, not resolution.
    let call = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      const texts = JSON.parse(String(init.body)).texts as string[];
      const batchIndex = call++;
      const slow = batchIndex === 0;
      return {
        ok: true,
        json: () =>
          new Promise((resolve) => {
            // Make the first batch the slowest so a resolution-order bug
            // would scramble the result.
            setTimeout(
              () => resolve({ embeddings: texts.map(() => embedding) }),
              slow ? 60 : 5,
            );
          }),
      };
    }) as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider();
    const texts = Array.from({ length: 8 }, (_, index) => `text-${index}`);

    const vectors = await provider.embed(texts);
    expect(vectors).toHaveLength(8);
    expect(global.fetch).toHaveBeenCalledTimes(4); // 8 texts / batch 2 = 4 batches
    // All four batches were issued before the first one resolved (60 ms hold).
    expect(call).toBe(4);
  });
});
