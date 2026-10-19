import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosError } from "axios";
import AdmZip from "adm-zip";
import md5 from "md5";
import { XMLParser } from "fast-xml-parser";
import {
  FetchedLaw,
  LawDocumentXml,
  NormMetadaten,
  ParsedChunk,
  ParsedNorm,
} from "./ingestion.types";
import { chunkNormText } from "./chunk-norm-text";
import { GII_USER_AGENT, toTrustedLawUrl } from "./trusted-law-url";

const MAX_ZIP_ENTRY_SIZE = 50 * 1024 * 1024; // 50MB uncompressed — generous for a single law's XML
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100MB — caps the raw HTTP response before any zip/XML parsing runs

@Injectable()
export class LawFetcherService {
  private readonly logger = new Logger(LawFetcherService.name);

  private readonly xmlParser = new XMLParser({
    ignoreAttributes: true,
    isArray: (tagName: string) => tagName === "norm",
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: true,
    cdataPropName: "__cdata",
  });

  async fetchLaw(
    law: { id: string; title: string; xmlUrl: string; checksum: string | null; etag: string | null },
  ): Promise<FetchedLaw> {
    // Defense-in-depth: GiiCrawlerService already gates this at discovery
    // time, but re-check here in case a Law row was seeded/edited by another
    // path — this is the last gate before a network request goes out.
    const trustedUrl = toTrustedLawUrl(law.xmlUrl);
    if (!trustedUrl) {
      this.logger.warn(
        `${law.id}: xmlUrl failed trusted-host check (${law.xmlUrl}), skipping fetch`,
      );
      return { chunks: [], checksum: "", etag: null, skipped: false };
    }

    let rawData: Buffer;
    let responseEtag: string | null = null;

    try {
      const response = await axios.get<ArrayBuffer>(trustedUrl, {
        responseType: "arraybuffer",
        timeout: 60_000,
        maxContentLength: MAX_DOWNLOAD_SIZE,
        maxBodyLength: MAX_DOWNLOAD_SIZE,
        // GII serves static files with no reason to redirect; a redirect
        // target isn't re-validated against the trusted-host allowlist, so
        // fail closed instead of silently following it off-domain.
        maxRedirects: 0,
        // ETag-based skip: the daily ingestAll() used to download every law's
        // full zip only to compare checksums. GII's Apache ETag is stable per
        // file version, so an unchanged law now costs a 304 header round trip.
        // The md5 checksum comparison below remains as a fallback for servers
        // that ignore If-None-Match or serve 200.
        headers: {
          "User-Agent": GII_USER_AGENT,
          ...(law.etag ? { "If-None-Match": law.etag } : {}),
        },
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 304,
      });
      if (response.status === 304) {
        this.logger.log(`${law.id}: ETag match (304), skipping download`);
        return {
          chunks: [],
          checksum: law.checksum ?? "",
          etag: law.etag,
          skipped: true,
        };
      }
      responseEtag =
        typeof (response.headers as Record<string, unknown> | undefined)?.etag === "string"
          ? ((response.headers as Record<string, unknown>).etag as string)
          : null;
      rawData = Buffer.from(response.data);
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      this.logger.warn(
        `Could not download ${law.xmlUrl} (${status ?? "network error"})`,
      );
      return { chunks: [], checksum: "", etag: null, skipped: false };
    }

    const checksum = md5(rawData);
    if (law.checksum !== null && law.checksum === checksum) {
      this.logger.log(`${law.id}: checksum unchanged, skipping parse`);
      return {
        chunks: [],
        checksum,
        etag: responseEtag ?? law.etag,
        skipped: true,
      };
    }

    const chunks = this.parseBuffer(rawData, law.id, law.title);
    this.logger.log(`${law.id}: parsed ${chunks.length} chunks`);
    return { chunks, checksum, etag: responseEtag, skipped: false };
  }

  private parseBuffer(
    data: Buffer,
    lawId: string,
    lawTitle: string,
  ): ParsedChunk[] {
    // Try as ZIP first (the normal case for GII)
    if (this.isZip(data)) {
      return this.parseZip(data, lawId, lawTitle);
    }
    // Fallback: raw XML
    return this.parseXml(data.toString("utf-8"), lawId, lawTitle);
  }

  private isZip(data: Buffer): boolean {
    // ZIP magic bytes: 50 4B 03 04
    return data[0] === 0x50 && data[1] === 0x4b;
  }

  private parseZip(
    data: Buffer,
    lawId: string,
    lawTitle: string,
  ): ParsedChunk[] {
    let zip: AdmZip;
    try {
      zip = new AdmZip(data);
    } catch {
      this.logger.warn(`${lawId}: failed to unzip, skipping`);
      return [];
    }

    let entries: AdmZip.IZipEntry[];
    try {
      entries = zip.getEntries();
    } catch {
      this.logger.warn(`${lawId}: failed to read zip entries, skipping`);
      return [];
    }

    const chunks: ParsedChunk[] = [];

    for (const entry of entries) {
      if (!entry.entryName.endsWith(".xml")) continue;
      if (entry.header.size > MAX_ZIP_ENTRY_SIZE) {
        this.logger.warn(
          `${lawId}: entry ${entry.entryName} exceeds ${MAX_ZIP_ENTRY_SIZE} bytes uncompressed (${entry.header.size}), skipping`,
        );
        continue;
      }

      let xml: string;
      try {
        // adm-zip caps real inflate output at the entry's declared
        // uncompressed size via Node's zlib maxOutputLength — a crafted
        // entry that lies about entry.header.size to slip past the check
        // above throws here instead of allocating past it. Same path
        // catches a bad-CRC/corrupt entry.
        xml = entry.getData().toString("utf-8");
      } catch (err) {
        this.logger.warn(
          `${lawId}: failed to decompress entry ${entry.entryName}, skipping: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      chunks.push(...this.parseXml(xml, lawId, lawTitle));
    }

    return chunks;
  }

  private parseXml(
    xml: string,
    lawId: string,
    lawTitle: string,
  ): ParsedChunk[] {
    let parsed: LawDocumentXml;
    try {
      parsed = this.xmlParser.parse(xml) as LawDocumentXml;
    } catch {
      this.logger.warn(`${lawId}: XML parse error, skipping`);
      return [];
    }

    const norms: ParsedNorm[] = parsed?.dokumente?.norm ?? [];
    const chunks: ParsedChunk[] = [];

    for (const norm of norms) {
      const meta: NormMetadaten = norm.metadaten ?? {};

      const rawEnbez = meta.enbez;
      if (rawEnbez === undefined || rawEnbez === null) continue;

      const normKey = String(rawEnbez).trim();
      if (!normKey) continue;

      const heading = String(meta.titel ?? "").trim() || null;

      const textNode = norm.textdaten?.text;
      if (!textNode) continue;

      const rawText = extractTextContent(textNode);
      if (!rawText.trim()) continue;

      const normLine = heading ? `${normKey} ${heading}` : normKey;
      const prefix = `${lawTitle}\n${normLine}\n\n`;

      const normChunks = chunkNormText(rawText, normKey, prefix);

      // Restore the original heading on all sub-chunks (chunkNormText sets null)
      for (const c of normChunks) {
        c.heading = heading;
      }

      chunks.push(...normChunks);
    }

    return chunks;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Defense-in-depth against a pathologically/hostilely nested XML document
// causing a stack-overflow DoS during recursion — legitimate GII norm text
// nests only a handful of levels deep (P, list, footnote ref), so this is
// far above any real structure while still bounding worst-case recursion.
const MAX_XML_NESTING_DEPTH = 100;

export function extractTextContent(
  value: unknown,
  parentKey?: string,
  depth = 0,
): string {
  if (depth > MAX_XML_NESTING_DEPTH) return "";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return "";
  if (Array.isArray(value)) {
    // Repeated <P> siblings are distinct Absätze (block-level) — separate them
    // with a blank line so chunkNormText's paragraph split can fire. All other
    // repeated inline nodes stay space-joined.
    const sep = parentKey === "P" ? "\n\n" : " ";
    return value.map((v) => extractTextContent(v, parentKey, depth + 1)).join(sep);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("@") && key !== "table")
      .map(([key, val]) => extractTextContent(val, key, depth + 1))
      .join(" ");
  }
  return "";
}
