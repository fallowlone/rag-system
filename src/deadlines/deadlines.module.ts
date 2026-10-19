import { Module } from "@nestjs/common";
import { DeadlineService } from "./deadline.service";

@Module({
  providers: [DeadlineService],
  exports: [DeadlineService],
})
export class DeadlinesModule {}
