import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AppAuthGuard } from "./app-auth.guard";
import { VisionService } from "../vision/vision.service";

// ~8 MB of binary (base64 inflates by 4/3) — comfortably under the 20 MB
// body limit, above the per-image vision cap enforced by the service
// (VISION_MAX_IMAGE_BYTES, raw bytes).
const ScanImageBodySchema = z.object({
  /** Raw image bytes (JPEG/PNG/WEBP/GIF) as a base64 string. */
  image: z.string().min(100).max(12_000_000),
  /** UI language for the prompt hint (transcription stays verbatim). */
  language: z.string().min(2).max(8).optional(),
});

/**
 * Stateless server-side scan for the macOS companion app: the device sends
 * image bytes, Sonnet transcribes them, and NOTHING is persisted — no
 * UserMemory/UserDocument rows, no logs of the content. The client stores
 * the returned text locally as the document's raw text. Explicit opt-in on
 * the device (Settings, default off): this is the only /app/v1 endpoint
 * that receives raw user imagery.
 */
@Controller("app/v1/scan-image")
@UseGuards(AppAuthGuard)
export class AppScanController {
  constructor(private readonly vision: VisionService) {}

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post()
  @HttpCode(200)
  // Note: no @Req() — the endpoint is stateless and persists nothing; the
  // class-level guard still rejects unauthenticated callers.
  async scan(@Body() rawBody: unknown): Promise<{ text: string }> {
    const parsed = ScanImageBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    // `Buffer.from(x, "base64")` never throws — it silently drops every
    // character outside the alphabet, so the previous try/catch was
    // unreachable and malformed input arrived as garbage bytes. Validate the
    // encoding explicitly instead.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.data.image)) {
      throw new BadRequestException("image must be valid base64");
    }
    const buffer = Buffer.from(parsed.data.image, "base64");
    if (buffer.length === 0) {
      throw new BadRequestException("image must be valid base64");
    }
    const text = await this.vision.transcribeImage(
      buffer,
      parsed.data.language ?? "de",
    );
    return { text };
  }
}
