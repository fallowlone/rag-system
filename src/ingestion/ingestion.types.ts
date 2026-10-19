// ── Provider contracts ───────────────────────────────────────────────────────

export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");

export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface LawIndex {
  id: string; // Abkürzung, e.g. "BGB"
  title: string; // full official title
  xmlUrl: string; // URL to xml.zip
}

export interface ParsedChunk {
  normKey: string; // <enbez> value, e.g. "§ 1"
  heading: string | null; // <titel> if present
  text: string; // cleaned plain text
}

export interface FetchedLaw {
  chunks: ParsedChunk[];
  checksum: string; // md5 of the downloaded raw bytes, computed once here and reused by the caller
  etag: string | null; // HTTP ETag of the downloaded resource (null when the server sent none or the law was skipped)
  skipped: boolean; // true = ETag/checksum matched the previous fetch, download/parse was skipped entirely
}

export interface IngestionResult {
  lawId: string;
  chunksInserted: number;
  skipped: boolean; // true = checksum unchanged, no work done
}

export interface IngestionAllResult {
  processed: number;
  skipped: number;
  failed: number;
  totalChunks: number;
  // Fetch/parse failures yield zero chunks without touching the DB — they
  // retry next tick. Counting them as `processed` hid outages in the metrics.
  empty: number;
}

// ── XML parsing shapes (internal) ────────────────────────────────────────────

export interface GiiTocItem {
  // Actual GII TOC structure: only <title> and <link> are present.
  // <link> is a full URL, e.g. "http://www.gesetze-im-internet.de/bgb/xml.zip"
  title?: string;
  link?: string;
}

export interface GiiTocXml {
  items?: {
    item?: GiiTocItem[];
  };
}

export interface NormMetadaten {
  enbez?: string | number;
  titel?: string;
}

export interface NormTextdaten {
  text?: unknown;
  fussnoten?: unknown;
}

export interface ParsedNorm {
  metadaten?: NormMetadaten;
  textdaten?: NormTextdaten;
}

export interface LawDocumentXml {
  dokumente?: {
    norm?: ParsedNorm[];
  };
}
