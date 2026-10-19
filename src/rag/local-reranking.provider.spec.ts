import { LocalRerankingProvider } from "./local-reranking.provider";
import { LOCAL_RERANKING_PROVIDER_ID } from "../config/local-retrieval.constants";

describe("LocalRerankingProvider", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

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

  it("posts candidates to the local rerank endpoint and returns scores", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        results: [
          { index: 1, score: 0.9 },
          { index: 0, score: 0.2 },
        ],
      }),
    }) as unknown as typeof fetch;
    const provider = new LocalRerankingProvider();

    expect(provider.id).toBe(LOCAL_RERANKING_PROVIDER_ID);
    await expect(provider.rerank("q", ["a", "b"], 2)).resolves.toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://retrieval.test:8000/rerank",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "q", documents: ["a", "b"], topK: 2 }),
      }),
    );
  });

  it("performs one HTTP attempt per provider call because RetrievalService owns retries", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("service down"));
    const provider = new LocalRerankingProvider();

    await expect(provider.rerank("q", ["a"], 1)).rejects.toThrow("service down");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
