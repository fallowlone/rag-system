import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AppAuthGuard } from "./app-auth.guard";
import { AppAuthedRequest } from "./app-api.types";
import { AppSyncService, SYNC_MAX_LIMIT } from "./app-sync.service";

const SyncQuerySchema = z.object({
  /**
   * Opaque cursor from the previous response's `nextCursor` (per-collection
   * keyset positions; legacy plain ISO-8601 cursors from older app versions
   * are accepted too — the service parses both and 400s on garbage).
   * Omit for a full pull.
   */
  cursor: z.string().min(1).max(4000).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SYNC_MAX_LIMIT)
    .default(200),
});

@Controller("app/v1/sync")
@UseGuards(AppAuthGuard)
export class AppSyncController {
  constructor(private readonly sync: AppSyncService) {}

  @Get()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async delta(@Req() req: AppAuthedRequest, @Query() rawQuery: unknown) {
    const parsed = SyncQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.sync.delta(req.appSession.userId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }
}
