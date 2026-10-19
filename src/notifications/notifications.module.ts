import { Module } from "@nestjs/common";
import { TelegramModule } from "../telegram/telegram.module";
import { DeadlinesModule } from "../deadlines/deadlines.module";
import { MemoryModule } from "../memory/memory.module";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [TelegramModule, DeadlinesModule, MemoryModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
