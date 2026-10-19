import axios from "axios";
import AdmZip from "adm-zip";
import { LawFetcherService } from "./law-fetcher.service";

jest.mock("axios");

describe("LawFetcherService.fetchLaw checksum gating", () => {
  function buildService() {
    return new LawFetcherService();
  }

  const law = {
    id: "bgb",
    title: "Bürgerliches Gesetzbuch",
    xmlUrl: "https://www.gesetze-im-internet.de/bgb/xml.zip",
    checksum: null as string | null,
    etag: null as string | null,
  };

  it("skips parsing entirely when the computed checksum matches previousChecksum", async () => {
    const rawData = Buffer.from("raw law bytes");
    (axios.get as jest.Mock).mockResolvedValue({ data: rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) });

    const service = buildService();
    const parseBufferSpy = jest.spyOn(
      service as unknown as { parseBuffer: (...args: unknown[]) => unknown },
      "parseBuffer",
    );

    // First call establishes the checksum for this rawData
    const first = await service.fetchLaw(law);
    expect(first.skipped).toBe(false);
    expect(parseBufferSpy).toHaveBeenCalledTimes(1);

    // Second call with previousChecksum equal to the first result's checksum must skip parseBuffer
    law.checksum = first.checksum;
    law.etag = first.etag;
    const second = await service.fetchLaw(law);
    expect(second.skipped).toBe(true);
    expect(second.chunks).toEqual([]);
    expect(parseBufferSpy).toHaveBeenCalledTimes(1); // still 1 — not called again
  });

  it("parses normally when previousChecksum is null (first ingestion)", async () => {
    const rawData = Buffer.from("<xml>raw</xml>");
    (axios.get as jest.Mock).mockResolvedValue({ data: rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) });

    const service = buildService();
    const result = await service.fetchLaw(law);
    expect(result.skipped).toBe(false);
    expect(result.checksum).toHaveLength(32); // md5 hex length
  });
});

describe("LawFetcherService.fetchLaw trusted-host guard", () => {
  it("skips the fetch entirely (never calls axios) when xmlUrl is not the trusted GII host", async () => {
    const service = new LawFetcherService();
    const untrustedLaw = {
      id: "bgb",
      title: "Bürgerliches Gesetzbuch",
      xmlUrl: "http://evil.example.com/bgb/xml.zip",
    };

    const callsBefore = (axios.get as jest.Mock).mock.calls.length;
    const result = await service.fetchLaw({ ...untrustedLaw, checksum: null, etag: null });

    expect(result).toEqual({ chunks: [], checksum: "", etag: null, skipped: false });
    // axios is a module-level mock shared across this file's tests, so assert
    // no *new* call happened rather than zero total calls.
    expect((axios.get as jest.Mock).mock.calls.length).toBe(callsBefore);
  });

  it("rewrites a plain-http GII url to https before fetching", async () => {
    const rawData = Buffer.from("<xml>raw</xml>");
    (axios.get as jest.Mock).mockResolvedValue({ data: rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) });

    const service = new LawFetcherService();
    const httpLaw = {
      id: "bgb",
      title: "Bürgerliches Gesetzbuch",
      xmlUrl: "http://www.gesetze-im-internet.de/bgb/xml.zip",
    };

    await service.fetchLaw({ ...httpLaw, checksum: null, etag: null });

    expect(axios.get).toHaveBeenCalledWith(
      "https://www.gesetze-im-internet.de/bgb/xml.zip",
      expect.anything(),
    );
  });
});

describe("LawFetcherService.fetchLaw download-size safety", () => {
  it("caps the axios download and refuses to follow redirects", async () => {
    const rawData = Buffer.from("<xml>raw</xml>");
    (axios.get as jest.Mock).mockResolvedValue({ data: rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) });

    const service = new LawFetcherService();
    await service.fetchLaw({
      id: "bgb",
      title: "BGB",
      xmlUrl: "https://www.gesetze-im-internet.de/bgb/xml.zip",
      checksum: null,
      etag: null,
    });

    expect(axios.get).toHaveBeenCalledWith(
      "https://www.gesetze-im-internet.de/bgb/xml.zip",
      expect.objectContaining({
        maxContentLength: expect.any(Number),
        maxBodyLength: expect.any(Number),
        maxRedirects: 0,
      }),
    );
  });
});

describe("LawFetcherService.parseZip zip-bomb guard", () => {
  it("skips an entry whose uncompressed size exceeds the cap, still parses other valid entries", async () => {
    await jest.isolateModulesAsync(async () => {
      // Create test data with normal entry
      const zip = new AdmZip();
      zip.addFile("normal.xml", Buffer.from("<dokumente><norm><metadaten><enbez>§ 1</enbez></metadaten><textdaten><text>Text</text></textdaten></norm></dokumente>"));
      const zipBuffer = zip.toBuffer();

      // Get real entries
      const referenceZip = new AdmZip(zipBuffer);
      const realEntries = referenceZip.getEntries();

      // Create mock oversized entry
      const oversizedEntry = {
        entryName: "huge.xml",
        header: { size: 200 * 1024 * 1024 },
        getData: jest.fn(() => Buffer.from("<dokumente></dokumente>")),
      };

      // Mock AdmZip before importing service
      jest.doMock("adm-zip", () => {
        return jest.fn().mockImplementation(() => ({
          getEntries: jest.fn().mockReturnValue([
            ...realEntries,
            oversizedEntry as unknown,
          ]),
        }));
      });

      // Now import the service with mocked AdmZip
      const { LawFetcherService: ServiceWithMockedAdmZip } = await import(
        "./law-fetcher.service"
      );
      const service = new ServiceWithMockedAdmZip();

      const chunks = (
        service as unknown as {
          parseZip: (data: Buffer, lawId: string, lawTitle: string) => unknown[];
        }
      ).parseZip(zipBuffer, "bgb", "BGB");

      expect(oversizedEntry.getData).not.toHaveBeenCalled();
      expect(chunks.length).toBeGreaterThan(0); // normal.xml still parsed
    });
  });

  it("skips an entry whose decompression throws (e.g. a lied-about size tripping zlib maxOutputLength), still parses other valid entries", async () => {
    await jest.isolateModulesAsync(async () => {
      const zip = new AdmZip();
      zip.addFile("normal.xml", Buffer.from("<dokumente><norm><metadaten><enbez>§ 1</enbez></metadaten><textdaten><text>Text</text></textdaten></norm></dokumente>"));
      const zipBuffer = zip.toBuffer();

      const referenceZip = new AdmZip(zipBuffer);
      const realEntries = referenceZip.getEntries();

      const corruptEntry = {
        entryName: "corrupt.xml",
        header: { size: 1024 }, // under the cap, so it reaches getData()
        getData: jest.fn(() => {
          throw new RangeError("Cannot create a Buffer larger than 0x... bytes");
        }),
      };

      jest.doMock("adm-zip", () => {
        return jest.fn().mockImplementation(() => ({
          getEntries: jest.fn().mockReturnValue([...realEntries, corruptEntry as unknown]),
        }));
      });

      const { LawFetcherService: ServiceWithMockedAdmZip } = await import(
        "./law-fetcher.service"
      );
      const service = new ServiceWithMockedAdmZip();

      const chunks = (
        service as unknown as {
          parseZip: (data: Buffer, lawId: string, lawTitle: string) => unknown[];
        }
      ).parseZip(zipBuffer, "bgb", "BGB");

      expect(corruptEntry.getData).toHaveBeenCalled();
      expect(chunks.length).toBeGreaterThan(0); // normal.xml still parsed despite the other entry throwing
    });
  });

  it("returns no chunks (not a crash) when zip.getEntries() itself throws", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("adm-zip", () => {
        return jest.fn().mockImplementation(() => ({
          getEntries: jest.fn(() => {
            throw new Error("corrupt central directory");
          }),
        }));
      });

      const { LawFetcherService: ServiceWithMockedAdmZip } = await import(
        "./law-fetcher.service"
      );
      const service = new ServiceWithMockedAdmZip();

      const chunks = (
        service as unknown as {
          parseZip: (data: Buffer, lawId: string, lawTitle: string) => unknown[];
        }
      ).parseZip(Buffer.from("PK\x03\x04fake"), "bgb", "BGB");

      expect(chunks).toEqual([]);
    });
  });
});
