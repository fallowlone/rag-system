import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AppAuthGuard } from "./app-auth.guard";
import { AppHintsService } from "./app-hints.service";
import { AppAuthedRequest, AppHint } from "./app-api.types";

/**
 * Proactive cross-document hints for the macOS companion app. Computed on
 * demand (no scheduler, no new tables) from rows the ingest path already
 * maintains — missing Widerspruch deadlines, stale active flags, deadline
 * collisions, and documents whose analysis never ran.
 */
@Controller("app/v1/hints")
@UseGuards(AppAuthGuard)
export class AppHintsController {
  constructor(private readonly hintsService: AppHintsService) {}

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get()
  async hints(@Req() req: AppAuthedRequest): Promise<{ hints: AppHint[] }> {
    const hints = await this.hintsService.hints(req.appSession.userId);
    return { hints };
  }
}
