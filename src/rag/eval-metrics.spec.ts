import {
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  summarizeLatency,
} from "./eval-metrics";

describe("retrieval eval metrics", () => {
  it("computes recall and reciprocal rank from the first relevant result", () => {
    const ranked = [
      { relevant: false },
      { relevant: true },
      { relevant: false },
    ];

    expect(recallAtK(ranked, 1)).toBe(0);
    expect(recallAtK(ranked, 2)).toBe(1);
    expect(reciprocalRank(ranked)).toBe(0.5);
  });

  it("computes binary NDCG and supports more than one relevant chunk", () => {
    const ranked = [
      { relevant: true },
      { relevant: false },
      { relevant: true },
    ];

    expect(ndcgAtK(ranked, 2, 3)).toBeCloseTo(
      (1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)),
    );
  });

  it("summarizes latency with nearest-rank percentiles", () => {
    expect(summarizeLatency([10, 20, 30, 40, 100])).toEqual({
      meanMs: 40,
      p50Ms: 30,
      p95Ms: 100,
      maxMs: 100,
    });
  });
});
