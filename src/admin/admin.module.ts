import { Module } from "@nestjs/common";
import { IngestionModule } from "../ingestion/ingestion.module";
import { RagModule } from "../rag/rag.module";
import { MemoryModule } from "../memory/memory.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [IngestionModule, RagModule, MemoryModule],
  controllers: [AdminController],
})
export class AdminModule {}
