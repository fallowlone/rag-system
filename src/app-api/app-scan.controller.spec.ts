import { BadRequestException } from "@nestjs/common";
import { AppScanController } from "./app-scan.controller";
import { VisionService } from "../vision/vision.service";

function jpegBase64(size = 200): string {
  const buf = Buffer.alloc(size, 0x41);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf.toString("base64");
}

describe("AppScanController", () => {
  function buildController(transcribe?: jest.Mock) {
    const vision = {
      transcribeImage:
        transcribe ?? jest.fn().mockResolvedValue("Transkribierter Text"),
    } as unknown as VisionService;
    return { controller: new AppScanController(vision), vision };
  }

  it("decodes base64 and delegates to VisionService, persisting nothing", async () => {
    const transcribe = jest.fn().mockResolvedValue("Text");
    const { controller } = buildController(transcribe);

    const result = await controller.scan({
      image: jpegBase64(),
      language: "ru",
    });

    expect(result).toEqual({ text: "Text" });
    const [buffer, lang] = transcribe.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect((buffer as Buffer)[0]).toBe(0xff);
    expect(lang).toBe("ru");
  });

  it("defaults the language to German", async () => {
    const transcribe = jest.fn().mockResolvedValue("Text");
    const { controller } = buildController(transcribe);

    await controller.scan({ image: jpegBase64() });

    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), "de");
  });

  it("rejects missing/short/oversized payloads with 400 before any LLM call", async () => {
    const transcribe = jest.fn();
    const { controller } = buildController(transcribe);

    await expect(controller.scan({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.scan({ image: "aGVsbG8=" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.scan({ image: "a".repeat(12_000_001) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("surfaces vision validation (bad format) without persisting", async () => {
    const { controller } = buildController(
      jest
        .fn()
        .mockRejectedValue(new BadRequestException("Unsupported image format")),
    );

    await expect(
      controller.scan({ image: Buffer.from("not-an-image".padEnd(200, ".")).toString("base64") }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
