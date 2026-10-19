import axios from "axios";
import { GiiCrawlerService } from "./gii-crawler.service";
import { PrismaService } from "../prisma/prisma.service";

jest.mock("axios");

describe("GiiCrawlerService.fetchIndex trusted-host guard", () => {
  function buildService() {
    return new GiiCrawlerService({} as unknown as PrismaService);
  }

  it("rewrites plain-http GII links to https and keeps them", async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: `<?xml version="1.0" encoding="UTF-8" ?>
<items>
<item><title>BGB</title><link>http://www.gesetze-im-internet.de/bgb/xml.zip</link></item>
</items>`,
    });

    const service = buildService();
    const laws = await service.fetchIndex();

    expect(laws).toEqual([
      { id: "bgb", title: "BGB", xmlUrl: "https://www.gesetze-im-internet.de/bgb/xml.zip" },
    ]);
  });

  it("drops entries whose link points at an untrusted host", async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: `<?xml version="1.0" encoding="UTF-8" ?>
<items>
<item><title>BGB</title><link>http://www.gesetze-im-internet.de/bgb/xml.zip</link></item>
<item><title>Evil</title><link>http://evil.example.com/malware.zip</link></item>
</items>`,
    });

    const service = buildService();
    const laws = await service.fetchIndex();

    expect(laws).toHaveLength(1);
    expect(laws[0].id).toBe("bgb");
  });

  it("drops trusted-host links with a non-index URL shape instead of minting a wrong id", async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: `<?xml version="1.0" encoding="UTF-8" ?>
<items>
<item><title>BGB</title><link>https://www.gesetze-im-internet.de/bgb/xml.zip</link></item>
<item><title>Deep</title><link>https://www.gesetze-im-internet.de/a/b/xml.zip</link></item>
<item><title>NoZip</title><link>https://www.gesetze-im-internet.de/bgb/</link></item>
</items>`,
    });

    const service = buildService();
    const laws = await service.fetchIndex();

    expect(laws).toEqual([
      { id: "bgb", title: "BGB", xmlUrl: "https://www.gesetze-im-internet.de/bgb/xml.zip" },
    ]);
  });

  it("sends the TOC fetch with a size cap", async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: `<items></items>` });

    await buildService().fetchIndex();

    expect(axios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxContentLength: 10 * 1024 * 1024 }),
    );
  });

  it("chunks upserts and warns about TOC-vanished laws without deleting them", async () => {
    const transaction = jest.fn().mockResolvedValue([]);
    const prisma = {
      $transaction: transaction,
      law: {
        upsert: jest.fn((args: unknown) => args),
        findMany: jest.fn().mockResolvedValue([{ id: "bgb" }, { id: "old-law" }]),
      },
    };
    const service = new GiiCrawlerService(
      prisma as unknown as PrismaService,
    );
    const laws = Array.from({ length: 1200 }, (_, i) => ({
      id: `law-${i}`,
      title: `Law ${i}`,
      xmlUrl: `https://www.gesetze-im-internet.de/law-${i}/xml.zip`,
    }));

    await service.upsertLaws(laws);

    // 1200 laws → 3 chunked transactions, never one ~3k-op statement.
    expect(transaction).toHaveBeenCalledTimes(3);
    // Vanished-but-stored laws are reported, not deleted.
    expect(prisma.law.findMany).toHaveBeenCalled();
  });
});
