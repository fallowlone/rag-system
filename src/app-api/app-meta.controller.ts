import { Controller, Get } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

/**
 * Public client metadata. No guard by design — everything here is
 * non-sensitive (the bot username is visible to anyone who can message it).
 */
@Controller("app/v1/meta")
export class AppMetaController {
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get()
  meta(): { botUsername: string | null } {
    const username = process.env.TELEGRAM_BOT_USERNAME?.trim();
    return { botUsername: username ? username.replace(/^@/, "") : null };
  }
}
