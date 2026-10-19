import { CacheService } from "../cache/cache.service";
import { EmbeddingService } from "./embedding.service";
import { EmbeddingProvider } from "./ingestion.types";

function provider(id: string, embed: jest.Mock): EmbeddingProvider {
  return { id, embed };
}

describe("EmbeddingService", () => {
  it("delegates cache misses to the configured provider and caches the vectors", async () => {
    const embed = jest.fn().mockResolvedValue([[0.1, 0.2]]);
    const cache = {
      getJsonMany: jest.fn().mockResolvedValue([null]),
      setJsonMany: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const service = new EmbeddingService(cache, provider("model-a", embed));

    const result = await service.embed(["hello"]);

    expect(result).toEqual([[0.1, 0.2]]);
    expect(embed).toHaveBeenCalledWith(["hello"]);
    expect(cache.setJsonMany).toHaveBeenCalledWith(
      [{ key: expect.stringMatching(/^emb:/), value: [0.1, 0.2] }],
      86_400,
    );
  });

  it("uses provider-specific cache keys so embeddings from different models cannot mix", async () => {
    const cacheA = {
      getJsonMany: jest.fn().mockResolvedValue([null]),
      setJsonMany: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const cacheB = {
      getJsonMany: jest.fn().mockResolvedValue([null]),
      setJsonMany: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    await new EmbeddingService(
      cacheA,
      provider("model-a", jest.fn().mockResolvedValue([[1]])),
    ).embed(["same text"]);
    await new EmbeddingService(
      cacheB,
      provider("model-b", jest.fn().mockResolvedValue([[2]])),
    ).embed(["same text"]);

    const keyA = (cacheA.setJsonMany as jest.Mock).mock.calls[0]![0][0].key;
    const keyB = (cacheB.setJsonMany as jest.Mock).mock.calls[0]![0][0].key;
    expect(keyA).not.toBe(keyB);
  });

  it("rejects an invalid provider response instead of silently misaligning vectors", async () => {
    const cache = {
      getJsonMany: jest.fn().mockResolvedValue([null]),
      setJsonMany: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const service = new EmbeddingService(
      cache,
      provider("broken", jest.fn().mockResolvedValue([])),
    );

    await expect(service.embed(["hello"])).rejects.toThrow(
      "returned 0 vectors for 1 texts",
    );
  });
});
