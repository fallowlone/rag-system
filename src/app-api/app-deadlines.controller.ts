import {
  BadRequestException,
  Body,
  Controller,
  Patch,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { Throttle } from "@nestjs/throttler";
import { AppAuthGuard } from "./app-auth.guard";
import { DeadlineService } from "../deadlines/deadline.service";
import { AppAuthedRequest } from "./app-api.types";

const DeadlineCompleteSchema = z.object({
  completed: z.boolean(),
});

@Controller("app/v1/deadlines")
@UseGuards(AppAuthGuard)
export class AppDeadlinesController {
  constructor(private readonly deadlines: DeadlineService) {}

  /**
   * Marks a deadline done (or reopens it). Without this, a handled deadline
   * resurfaced in every morning tracker run — it could only be removed by
   * deleting its source.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Patch(":id")
  async setCompleted(
    @Req() req: AppAuthedRequest,
    @Param("id") deadlineId: string,
    @Body() rawBody: unknown,
  ) {
    const parsed = DeadlineCompleteSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const updated = await this.deadlines.setDeadlineCompleted(
      req.appSession.userId,
      deadlineId,
      parsed.data.completed,
    );
    if (!updated) {
      throw new BadRequestException("Deadline not found");
    }
    return { updated: true, completed: parsed.data.completed };
  }
}
