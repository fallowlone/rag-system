import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ConversationService } from "./conversation.service";
import { ConversationRetentionService } from "./conversation-retention.service";

@Global()
@Module({
  imports: [PrismaModule],
  providers: [ConversationService, ConversationRetentionService],
  exports: [ConversationService],
})
export class ConversationModule {}
