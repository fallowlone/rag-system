export const RERANKING_PROVIDER = Symbol("RERANKING_PROVIDER");

export interface RerankingResult {
  index: number;
  score: number;
}

export interface RerankingProvider {
  readonly id: string;
  rerank(
    query: string,
    documents: string[],
    topK: number,
  ): Promise<RerankingResult[]>;
}

export interface DebugSearchResult {
  lawId: string;
  normKey: string;
  similarity: number;
}

export interface ChunkSearchResult {
  id: string;
  lawId: string;
  normKey: string;
  heading: string | null;
  text: string;
  similarity: number;
}
