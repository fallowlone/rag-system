import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { recordTombstones } from "./deletion-tombstones";
import {
  AppTaskCreateInput,
  AppTaskRecord,
  AppTaskStatus,
  AppTaskUpdateInput,
} from "./app-api.types";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "done",
  "missed",
]);

/**
 * CRUD for UserTask — the companion app's task list (e.g. "submit documents
 * to the Jobcenter"). Every query is userId-scoped; ownership is enforced in
 * the WHERE clause (updateMany/deleteMany), not by trusting the id.
 */
@Injectable()
export class AppTasksService {
  private readonly logger = new Logger(AppTasksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    status?: AppTaskStatus,
  ): Promise<AppTaskRecord[]> {
    // No pagination on this endpoint: cap far above realistic personal
    // volume and log truncation instead of building an unbounded response.
    const LIST_MAX = 500;
    const tasks = await this.prisma.userTask.findMany({
      where: status ? { userId, status } : { userId },
      orderBy: [{ status: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
      take: LIST_MAX,
    });
    if (tasks.length === LIST_MAX) {
      this.logger.warn(
        `Task list for user ${userId} hit the ${LIST_MAX}-row cap — oldest rows omitted`,
      );
    }
    return tasks.map(toRecord);
  }

  async create(userId: string, input: AppTaskCreateInput): Promise<AppTaskRecord> {
    // A sourceDocumentId may only reference the user's own document (IDOR guard).
    if (input.sourceDocumentId) {
      const owned = await this.prisma.userDocument.findFirst({
        where: { id: input.sourceDocumentId, userId },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException("Source document not found");
      }
    }

    const task = await this.prisma.userTask.create({
      data: {
        userId,
        title: input.title,
        description: input.description ?? null,
        dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null,
        priority: input.priority,
        sourceType: input.sourceDocumentId ? "document" : "manual",
        sourceDocumentId: input.sourceDocumentId ?? null,
      },
    });
    this.logger.log(`Task ${task.id} created for user ${userId}`);
    return toRecord(task);
  }

  async update(
    userId: string,
    taskId: string,
    input: AppTaskUpdateInput,
  ): Promise<AppTaskRecord> {
    // The controller Zod enum already restricts this; the explicit throw
    // keeps direct service callers from silently partially-writing.
    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new BadRequestException(`Unknown status: ${input.status}`);
    }
    const status = input.status;

    const result = await this.prisma.userTask.updateMany({
      where: { id: taskId, userId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.dueDate !== undefined
          ? { dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null }
          : {}),
        ...(status !== undefined ? { status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        // completedAt follows the status transition
        ...(status === "done" ? { completedAt: new Date() } : {}),
        ...(status !== undefined && status !== "done" ? { completedAt: null } : {}),
      },
    });

    if (result.count === 0) {
      throw new NotFoundException("Task not found");
    }

    // updateMany succeeded, so the row exists and belongs to this user;
    // re-read defensively. A concurrent delete between the two queries
    // reads as 404, never as a 500 from findFirstOrThrow.
    const task = await this.prisma.userTask.findFirst({
      where: { id: taskId, userId },
    });
    if (!task) {
      throw new NotFoundException("Task not found");
    }
    return toRecord(task);
  }

  async delete(userId: string, taskId: string): Promise<boolean> {
    const result = await this.prisma.userTask.deleteMany({
      where: { id: taskId, userId },
    });
    if (result.count > 0) {
      // Sync tombstone so Mac clients drop the task instead of showing a
      // deleted row forever.
      await recordTombstones(this.prisma, userId, [
        { collection: "task", objectId: taskId },
      ]);
    }
    return result.count > 0;
  }
}

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueDate: Date | null;
  status: string;
  priority: string;
  sourceType: string;
  sourceDocumentId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(task: TaskRow): AppTaskRecord {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    dueDate: task.dueDate,
    status: task.status as AppTaskStatus,
    priority: task.priority as AppTaskRecord["priority"],
    sourceType: task.sourceType,
    sourceDocumentId: task.sourceDocumentId,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
