/**
 * Strips the chunk-split suffix (`_p<paragraphIndex>_c<chunkIndex>`, always
 * emitted together by chunkNormText — see src/ingestion/chunk-norm-text.ts)
 * from a normKey, e.g. "§ 573_p2_c1" -> "§ 573". Shared by answer.service.ts
 * (prompt-display: model should cite "§ 573", not "§ 573_p2_c1") and
 * retrieval.service.ts (parent-norm sibling grouping) — kept here to avoid
 * a circular import between the two (answer.service.ts already imports
 * RetrievalService).
 */
export function baseNormKey(normKey: string): string {
  return normKey.replace(/_p\d+_c\d+$/, "");
}
