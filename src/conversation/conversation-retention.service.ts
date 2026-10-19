import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

const RETENTION_DAYS = 14;
// 14 days, not 7: the nightly batch re-enqueues failed days across ~7 days,
// and purging input at the same boundary could erase a day's messages just
// before its retry reads them (diary gap after an outage).

@Injectable()
export class ConversationRetentionService {
  private readonly logger = new Logger(ConversationRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Daily at 03:00 server time. Cheap delete on an indexed column; safe to
  // run during low-traffic hours.
  @Cron("0 3 * * *")
  async purgeExpiredLogs(): Promise<void> {
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    try {
      const result = await this.prisma.conversationLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        this.logger.log(
          `Purged ${result.count} ConversationLog rows older than ${RETENTION_DAYS}d`,
        );
      }
    } catch (err) {
      this.logger.error(
        `ConversationLog retention purge failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
