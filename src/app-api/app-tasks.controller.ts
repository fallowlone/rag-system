import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { Throttle } from "@nestjs/throttler";
import { AppAuthGuard } from "./app-auth.guard";
import { AppTasksService } from "./app-tasks.service";
import { AppAuthedRequest } from "./app-api.types";
import { IsoDate } from "./iso-date";

const TaskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000).optional(),
  dueDate: IsoDate.nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  sourceDocumentId: z.string().uuid().optional(),
});

const TaskUpdateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(2000).nullable().optional(),
    dueDate: IsoDate.nullable().optional(),
    status: z.enum(["open", "in_progress", "done", "missed"]).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
  })
  .refine(
    (body) =>
      Object.values(body).some((value) => value !== undefined),
    { message: "at least one field must be provided" },
  );

const TaskListQuerySchema = z.object({
  status: z.enum(["open", "in_progress", "done", "missed"]).optional(),
});

@Controller("app/v1/tasks")
@UseGuards(AppAuthGuard)
export class AppTasksController {
  constructor(private readonly tasks: AppTasksService) {}

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get()
  list(@Req() req: AppAuthedRequest, @Query() rawQuery: unknown) {
    const parsed = TaskListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.tasks.list(req.appSession.userId, parsed.data.status);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post()
  @HttpCode(201)
  create(@Req() req: AppAuthedRequest, @Body() rawBody: unknown) {
    const parsed = TaskCreateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.tasks.create(req.appSession.userId, parsed.data);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Patch(":id")
  update(
    @Req() req: AppAuthedRequest,
    @Param("id") taskId: string,
    @Body() rawBody: unknown,
  ) {
    const parsed = TaskUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.tasks.update(req.appSession.userId, taskId, parsed.data);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Delete(":id")
  async delete(@Req() req: AppAuthedRequest, @Param("id") taskId: string) {
    const deleted = await this.tasks.delete(req.appSession.userId, taskId);
    if (!deleted) {
      throw new BadRequestException("Task not found");
    }
    return { deleted: true };
  }
}
