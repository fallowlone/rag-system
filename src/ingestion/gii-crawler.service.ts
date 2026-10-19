import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { XMLParser } from "fast-xml-parser";
import { PrismaService } from "../prisma/prisma.service";
import { GiiTocItem, GiiTocXml, LawIndex } from "./ingestion.types";
import { GII_USER_AGENT, toTrustedLawUrl } from "./trusted-law-url";

const GII_TOC_URL = "https://www.gesetze-im-internet.de/gii-toc.xml";
// The TOC is a small index file — anything larger is a server error or a
// hijacked response, not an index. Fail the fetch rather than parsing MBs
// of garbage into a wasteful full ingestAll no-op.
const TOC_MAX_BYTES = 10 * 1024 * 1024;
// One $transaction per chunk: ~3k upserts in a single statement risks
// statement-size/timeout failures and one giant write lock.
const UPSERT_CHUNK_SIZE = 500;

@Injectable()
export class GiiCrawlerService {
  private readonly logger = new Logger(GiiCrawlerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async fetchIndex(): Promise<LawIndex[]> {
    this.logger.log("Fetching GII TOC index…");

    const response = await axios.get<string>(GII_TOC_URL, {
      responseType: "text",
      timeout: 30_000,
      maxContentLength: TOC_MAX_BYTES,
      headers: { "User-Agent": GII_USER_AGENT },
    });

    const parser = new XMLParser({
      ignoreAttributes: true,
      isArray: (tagName: string) => tagName === "item",
      parseTagValue: false,
      trimValues: true,
      processEntities: true,
      htmlEntities: true,
    });

    const parsed = parser.parse(response.data) as GiiTocXml;
    const items: GiiTocItem[] = parsed?.items?.item ?? [];

    this.logger.debug(`Raw item count from parser: ${items.length}`);

    const laws: LawIndex[] = [];

    for (const item of items) {
      const title = item.title;
      if (!item.link || !title) continue;

      // Trust gate: only the GII host, normalized to https — the TOC itself
      // is untrusted remote input and this runs unattended on a weekly cron
      // (SyncSchedulerService.fullSync), so a malformed/hostile <link> must
      // never reach axios.get downstream in LawFetcherService.
      const xmlUrl = toTrustedLawUrl(item.link);
      if (!xmlUrl) {
        this.logger.warn(`Skipping untrusted law URL from GII index: ${item.link}`);
        continue;
      }

      // URL shape: "https://www.gesetze-im-internet.de/bgb/xml.zip"
      // Extract the slug (path segment between the domain and "/xml.zip") as the ID.
      const slug = extractSlug(xmlUrl);
      if (!slug) {
        this.logger.debug(`Skipping GII entry with unexpected URL shape: ${item.link}`);
        continue;
      }

      laws.push({ id: slug, title, xmlUrl });
    }

    this.logger.log(`Found ${laws.length} laws in GII index`);
    return laws;
  }

  async upsertLaws(laws: LawIndex[]): Promise<void> {
    // The weekly index crawl upserts ~3k laws; one round trip per law used to
    // make this the slowest part of the crawl. $transaction batches them —
    // chunked, since one ~3k-op statement risks size/timeout failures.
    for (let i = 0; i < laws.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = laws.slice(i, i + UPSERT_CHUNK_SIZE);
      await this.prisma.$transaction(
        chunk.map((law) =>
          this.prisma.law.upsert({
            where: { id: law.id },
            create: { id: law.id, title: law.title, xmlUrl: law.xmlUrl },
            update: { title: law.title, xmlUrl: law.xmlUrl },
          }),
        ),
      );
    }
    this.logger.log(`Upserted ${laws.length} laws into DB`);

    // Visibility, not deletion: laws that vanished from the TOC (repealed,
    // renamed) stay searchable until someone decides their fate — but the
    // drift must be loud, not silent.
    const stored = await this.prisma.law.findMany({ select: { id: true } });
    const tocIds = new Set(laws.map((law) => law.id));
    const vanished = stored
      .map((row) => row.id)
      .filter((id) => !tocIds.has(id));
    if (vanished.length > 0) {
      this.logger.warn(
        `Laws in DB but missing from TOC (${vanished.length}): ${vanished.slice(0, 20).join(", ")}${vanished.length > 20 ? "…" : ""} — decide delete-or-keep, they stay searchable meanwhile`,
      );
    }
  }
}

/**
 * Given a full zip URL like
 *   "http://www.gesetze-im-internet.de/bgb/xml.zip"
 * returns the slug "bgb".
 */
function extractSlug(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    // pathname = "/bgb/xml.zip"  →  segments = ["", "bgb", "xml.zip"]
    // Assert the full shape, not just the first segment: a GII path change
    // (or a crafted trusted-host URL) must yield null, never a wrong law id
    // that would mint phantom rows or collide with a real slug.
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[1] !== "xml.zip") return null;
    return segments[0] ?? null;
  } catch {
    return null;
  }
}
