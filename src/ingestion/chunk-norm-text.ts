import { ParsedChunk } from "./ingestion.types";

// Sized against the embedding service's EMBED_MAX_LENGTH (512 tokens, pinned
// in services/retrieval-models/app/main.py). BGE-M3 truncates silently past
// that, so an oversized chunk loses its tail from the vector with no error
// anywhere. German legal prose runs roughly 3-4 chars/token under the XLM-R
// tokenizer, so 1150 chars plus the norm prefix sits inside the window with
// margin — the assertion in the spec pins the relationship so a future raise
// has to think about it.
const CHUNK_SIZE = 1_150;
const CHUNK_OVERLAP = 250;
const WORD_SAFE_LOOKBACK = 150;

/**
 * Splits a norm's raw text into overlapping sub-chunks.
 *
 * Strategy:
 *  1. Split by paragraph boundaries (\n\n, fallback \n, fallback whole text).
 *  2. Normalize whitespace within each paragraph.
 *  3. Greedy-pack consecutive short paragraphs (each <= CHUNK_SIZE on its own)
 *     into a single chunk, joined by "\n\n", until the next paragraph would
 *     push the combined length past CHUNK_SIZE — then flush and start a new
 *     group. This keeps e.g. Abs.1 (general right) and Abs.2 (exception) of
 *     a short § together instead of competing as separate embeddings.
 *     Paragraphs > CHUNK_SIZE flush the current group first, then get their
 *     own word-safe sliding window: each slice extends to CHUNK_SIZE chars
 *     then backs off to the nearest preceding space (within
 *     WORD_SAFE_LOOKBACK chars) so words are never cut mid-token; the next
 *     slice starts CHUNK_OVERLAP chars before the previous slice's end, so
 *     consecutive slices overlap by roughly CHUNK_OVERLAP chars.
 *  4. normKey encodes position: `${baseNormKey}_p${p}_c${c}`, where `p` is
 *     the index of the *first* paragraph in the group (packed or not).
 *  5. Each chunk text is prefixed with lawTitle + normLine.
 */
/** Exported for the budget assertion in the spec. */
export const CHUNK_SIZE_CHARS = CHUNK_SIZE;

export function chunkNormText(
  rawText: string,
  baseNormKey: string,
  prefix: string,
): ParsedChunk[] {
  if (!rawText.trim()) return [];

  // Prefer double-newline split (Absatz boundaries); fallback to single newline;
  // fallback to treating the whole text as one paragraph (common in GII XML where
  // extractTextContent joins nodes with spaces, producing no newlines at all).
  let rawParagraphs: string[];
  if (rawText.includes("\n\n")) {
    rawParagraphs = rawText.split(/\n\n+/);
  } else if (rawText.includes("\n")) {
    rawParagraphs = rawText.split(/\n+/);
  } else {
    rawParagraphs = [rawText];
  }

  const paragraphs = rawParagraphs
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

  const chunks: ParsedChunk[] = [];

  let group: string[] = [];
  let groupStartIndex = 0;

  const flushGroup = () => {
    if (group.length === 0) return;
    chunks.push({
      normKey: `${baseNormKey}_p${groupStartIndex}_c0`,
      heading: null,
      text: prefix + group.join("\n\n"),
    });
    group = [];
  };

  paragraphs.forEach((paragraph, index) => {
    if (paragraph.length > CHUNK_SIZE) {
      flushGroup();

      let start = 0;
      let chunkIndex = 0;
      while (start < paragraph.length) {
        let end = Math.min(start + CHUNK_SIZE, paragraph.length);
        // Word-safe: unless this is the final slice, back off to the last space
        // within WORD_SAFE_LOOKBACK chars so we never cut mid-word.
        if (end < paragraph.length) {
          const ws = paragraph.lastIndexOf(" ", end);
          if (ws > start && ws >= end - WORD_SAFE_LOOKBACK) {
            end = ws;
          }
        }
        chunks.push({
          normKey: `${baseNormKey}_p${index}_c${chunkIndex}`,
          heading: null,
          text: prefix + paragraph.slice(start, end),
        });
        if (end >= paragraph.length) break;
        start = end - CHUNK_OVERLAP;
        chunkIndex++;
      }
      return;
    }

    const combinedLength =
      group.reduce((sum, p) => sum + p.length, 0) +
      group.length * 2 /* "\n\n" separators */ +
      paragraph.length;
    if (group.length > 0 && combinedLength > CHUNK_SIZE) {
      flushGroup();
    }
    if (group.length === 0) groupStartIndex = index;
    group.push(paragraph);
  });

  flushGroup();

  return chunks;
}
