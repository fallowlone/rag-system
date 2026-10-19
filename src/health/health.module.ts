import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { CacheModule } from "../cache/cache.module";
import { LocalRetrievalHealthService } from "./local-retrieval-health.service";

@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [HealthController],
  providers: [LocalRetrievalHealthService],
})
export class HealthModule {}
