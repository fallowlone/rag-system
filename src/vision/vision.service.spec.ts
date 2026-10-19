import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException } from "@nestjs/common";
import { detectImageMime, VisionService } from "./vision.service";
import { VISION_MAX_IMAGE_BYTES } from "./vision.types";

jest.mock("@anthropic-ai/sdk");

const ORIGINAL_ENV = process.env;

function jpegBytes(extra = 100): Buffer {
  const buf = Buffer.alloc(extra + 3, 0x41);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

describe("detectImageMime", () => {
  it("detects jpeg/png/webp/gif by magic bytes", () => {
    expect(detectImageMime(jpegBytes())).toBe("image/jpeg");
    expect(
      detectImageMime(
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]),
      ),
    ).toBe("image/png");
    expect(
      detectImageMime(
        Buffer.concat([
          Buffer.from("RIFF", "ascii"),
          Buffer.alloc(4),
          Buffer.from("WEBP", "ascii"),
        ]),
      ),
    ).toBe("image/webp");
    expect(
      detectImageMime(Buffer.concat([Buffer.from("GIF89a", "ascii")])),
    ).toBe("image/gif");
  });

  it("returns null for non-images and truncated headers", () => {
    expect(detectImageMime(Buffer.from("%PDF-1.4 fake"))).toBeNull();
    expect(detectImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("VisionService.transcribeImage", () => {
  let createMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
    createMock = jest.fn();
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { create: createMock },
    }));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function service() {
    return new VisionService();
  }

  it("refuses to return a transcription cut short by the token budget", async () => {
    // The caller feeds this straight into fact extraction. Returning the
    // fragment would produce confident facts about a page the model only
    // half read — and nothing downstream could tell the difference.
    createMock.mockResolvedValue({
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 4000 },
      content: [{ type: "text", text: "Jobcenter Berlin Mitte, Bewilligungs" }],
    });

    await expect(service().transcribeImage(jpegBytes(), "de")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("sends an image block and returns the transcribed text", async () => {
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "text", text: "  Sehr geehrte Damen…  " }],
    });

    const text = await service().transcribeImage(jpegBytes(), "de");

    expect(text).toBe("Sehr geehrte Damen…");
    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe("claude-sonnet-5");
    expect(payload).not.toHaveProperty("temperature");
    const imageBlock = payload.messages[0].content[0];
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.source.media_type).toBe("image/jpeg");
    expect(typeof imageBlock.source.data).toBe("string");
    expect(payload.system).toContain("<immunity>");
  });

  it("returns empty string on safety refusal (not retryable)", async () => {
    createMock.mockResolvedValue({
      stop_reason: "refusal",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "I can't" }],
    });

    await expect(service().transcribeImage(jpegBytes(), "de")).resolves.toBe(
      "",
    );
  });

  it("returns empty string when no text block comes back", async () => {
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 0 },
      content: [],
    });

    await expect(service().transcribeImage(jpegBytes(), "de")).resolves.toBe(
      "",
    );
  });

  it("throws on API failures (retryable by the caller)", async () => {
    createMock.mockRejectedValue(new Error("Anthropic 500"));

    await expect(service().transcribeImage(jpegBytes(), "de")).rejects.toThrow(
      "Anthropic 500",
    );
  });

  it("rejects non-images and oversized photos before any LLM call", async () => {
    await expect(
      service().transcribeImage(Buffer.from("not an image"), "de"),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Derived from the constant, never a literal: the previous hard-coded
    // 5 MB was Bedrock's number, and the API's real ceiling is 10 MB of
    // BASE64 — a literal here would silently re-pin the wrong bound.
    const big = jpegBytes(VISION_MAX_IMAGE_BYTES + 1);
    await expect(service().transcribeImage(big, "de")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws without an API key", () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new VisionService()).toThrow("ANTHROPIC_API_KEY is not set");
  });
});
