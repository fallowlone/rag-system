export interface RankedRelevance {
  relevant: boolean;
}

export interface LatencySummary {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function reciprocalRank(items: RankedRelevance[]): number {
  const index = items.findIndex((item) => item.relevant);
  return index === -1 ? 0 : 1 / (index + 1);
}

export function recallAtK(items: RankedRelevance[], k: number): number {
  return items.slice(0, k).some((item) => item.relevant) ? 1 : 0;
}

export function ndcgAtK(items: RankedRelevance[], relevantCount: number, k: number): number {
  if (relevantCount <= 0 || k <= 0) return 0;

  const dcg = items.slice(0, k).reduce((sum, item, index) => {
    if (!item.relevant) return sum;
    return sum + 1 / Math.log2(index + 2);
  }, 0);

  const idealHits = Math.min(relevantCount, k);
  let idcg = 0;
  for (let index = 0; index < idealHits; index++) {
    idcg += 1 / Math.log2(index + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export function summarizeLatency(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const meanMs = values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    meanMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

function percentile(sortedValues: number[], fraction: number): number {
  const index = Math.max(
    0,
    Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index]!;
}
