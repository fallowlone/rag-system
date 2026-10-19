import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AppAuthService } from "./app-auth.service";
import { AppAuthGuard } from "./app-auth.guard";
import { AppAuthedRequest, DevicePairPollResult } from "./app-api.types";

const ProposeBodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, "must be a 6-digit code"),
  deviceName: z.string().min(1).max(100),
  /** 256-bit proposal secret (hex or base64url) — only its sha256 is stored. */
  secret: z.string().min(32).max(128),
});

const PairStatusBodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, "must be a 6-digit code"),
  secret: z.string().min(32).max(128),
});

@Controller("app/v1/auth")
export class AppAuthController {
  constructor(private readonly appAuth: AppAuthService) {}

  /**
   * Public by design — the device has no token yet. Registers the
   * device-generated pairing code for a later bot claim. First writer wins:
   * a code already proposed by another device gets a 409 (never an
   * overwrite), and the device retries with a fresh code. Tight throttle:
   * a code is 6 digits over 60 seconds.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post("pair-propose")
  @HttpCode(200)
  async propose(@Body() rawBody: unknown): Promise<{
    proposed: boolean;
    expiresIn: number;
  }> {
    const parsed = ProposeBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const registered = await this.appAuth.proposeDeviceCode(
      parsed.data.code,
      parsed.data.deviceName,
      parsed.data.secret,
    );
    if (!registered) {
      throw new ConflictException("Code already in use — retry with a fresh code");
    }
    return { proposed: true, expiresIn: 60 };
  }

  /**
   * Public by design — the device polls with code + proposal secret until the
   * user claims the code in Telegram. POST with a JSON body (never a GET
   * query): the secret must not land in proxy/access logs. Unknown code or
   * wrong secret reads as "not claimed", never as an error, so probes learn
   * nothing. Generous throttle: a client polls ~every 2s for the 60s code
   * lifetime.
   */
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Post("pair-status")
  @HttpCode(200)
  async pairStatus(@Body() rawBody: unknown): Promise<DevicePairPollResult> {
    const parsed = PairStatusBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.appAuth.pollDeviceClaim(parsed.data.code, parsed.data.secret);
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get("sessions")
  @UseGuards(AppAuthGuard)
  listSessions(@Req() req: AppAuthedRequest) {
    return this.appAuth.listSessions(req.appSession.userId);
  }

  /**
   * Self-revocation for the device's own session (the "Unpair" button).
   * The device knows its token but not its session id, so the guard's
   * attached session is the scope — no id parameter, no IDOR surface.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Delete("session")
  @UseGuards(AppAuthGuard)
  async revokeOwnSession(
    @Req() req: AppAuthedRequest,
  ): Promise<{ revoked: boolean }> {
    const revoked = await this.appAuth.revokeSession(
      req.appSession.sessionId,
      req.appSession.userId,
    );
    if (!revoked) {
      throw new BadRequestException("Session not found or already revoked");
    }
    return { revoked: true };
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Delete("sessions/:id")
  @UseGuards(AppAuthGuard)
  async revokeSession(
    @Req() req: AppAuthedRequest,
    @Param("id") sessionId: string,
  ): Promise<{ revoked: boolean }> {
    const revoked = await this.appAuth.revokeSession(
      sessionId,
      req.appSession.userId,
    );
    if (!revoked) {
      throw new BadRequestException("Session not found or already revoked");
    }
    return { revoked: true };
  }

  /**
   * Rotates the device's own session: fresh token + fresh expiry, returned
   * once — the device must persist it immediately (same rule as the pairing
   * poll). Scope comes from the guard's session: a device can only rotate
   * itself, so there is no session-id parameter and no IDOR surface.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post("session/rotate")
  @UseGuards(AppAuthGuard)
  async rotateOwnSession(@Req() req: AppAuthedRequest): Promise<{
    token: string;
    sessionId: string;
    expiresAt: Date;
  }> {
    const rotated = await this.appAuth.rotateSession(
      req.appSession.sessionId,
      req.appSession.userId,
    );
    if (!rotated) {
      throw new BadRequestException(
        "Session not found, revoked or expired — pair again",
      );
    }
    return rotated;
  }
}
