import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AppTasksService } from "./app-tasks.service";
import { PrismaService } from "../prisma/prisma.service";

const taskRow = {
  id: "task-1",
  title: "Nachweis einreichen",
  description: null,
  dueDate: new Date("2026-09-01T00:00:00Z"),
  status: "open",
  priority: "normal",
  sourceType: "manual",
  sourceDocumentId: null,
  completedAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

describe("AppTasksService", () => {
  function buildService(options?: {
    ownedDocument?: boolean;
    updateCount?: number;
    deleteCount?: number;
  }) {
    const prisma = {
      userTask: {
        findMany: jest.fn().mockResolvedValue([taskRow]),
        create: jest.fn().mockResolvedValue(taskRow),
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: options?.updateCount ?? 1 }),
        findFirst: jest.fn().mockResolvedValue(taskRow),
        deleteMany: jest
          .fn()
          .mockResolvedValue({ count: options?.deleteCount ?? 1 }),
      },
      userDocument: {
        findFirst: jest
          .fn()
          .mockResolvedValue(options?.ownedDocument === false ? null : { id: "doc-1" }),
      },
      syncTombstone: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    return { service: new AppTasksService(prisma), prisma };
  }

  describe("create", () => {
    it("creates a manual task", async () => {
      const { service, prisma } = buildService();
      const task = await service.create("user-1", {
        title: "Nachweis einreichen",
        priority: "normal",
      });
      expect(task.id).toBe("task-1");
      expect(prisma.userTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: "user-1",
            sourceType: "manual",
            sourceDocumentId: null,
          }),
        }),
      );
    });

    it("rejects a sourceDocumentId that belongs to another user (IDOR guard)", async () => {
      const { service } = buildService({ ownedDocument: false });
      await expect(
        service.create("user-1", {
          title: "Task",
          priority: "normal",
          sourceDocumentId: "foreign-doc",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("marks sourceType 'document' when linked to an owned document", async () => {
      const { service, prisma } = buildService();
      await service.create("user-1", {
        title: "Task",
        priority: "normal",
        sourceDocumentId: "doc-1",
      });
      expect(prisma.userTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sourceType: "document" }),
        }),
      );
    });
  });

  describe("update", () => {
    it("scopes the update to the owner and sets completedAt when done", async () => {
      const { service, prisma } = buildService();
      await service.update("user-1", "task-1", { status: "done" });
      expect(prisma.userTask.updateMany).toHaveBeenCalledWith({
        where: { id: "task-1", userId: "user-1" },
        data: expect.objectContaining({
          status: "done",
          completedAt: expect.any(Date),
        }),
      });
    });

    it("clears completedAt when the task is reopened", async () => {
      const { service, prisma } = buildService();
      await service.update("user-1", "task-1", { status: "open" });
      const data = (prisma.userTask.updateMany as jest.Mock).mock.calls[0][0]
        .data;
      expect(data.completedAt).toBeNull();
    });

    it("throws NotFound when the task belongs to another user", async () => {
      const { service } = buildService({ updateCount: 0 });
      await expect(
        service.update("user-1", "foreign-task", { status: "done" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequest on an unknown status instead of silently dropping it", async () => {
      const { service, prisma } = buildService();
      await expect(
        service.update("user-1", "task-1", {
          status: "archived" as never,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.userTask.updateMany).not.toHaveBeenCalled();
    });

    it("reads a concurrent delete as NotFound, not a 500", async () => {
      const { service, prisma } = buildService();
      (prisma.userTask.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.update("user-1", "task-1", { title: "x" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("delete", () => {
    it("scopes deletion to the owner", async () => {
      const { service, prisma } = buildService();
      expect(await service.delete("user-1", "task-1")).toBe(true);
      expect(prisma.userTask.deleteMany).toHaveBeenCalledWith({
        where: { id: "task-1", userId: "user-1" },
      });
    });

    it("returns false for a foreign or missing task", async () => {
      const { service } = buildService({ deleteCount: 0 });
      expect(await service.delete("user-1", "foreign-task")).toBe(false);
    });

    it("records a tombstone so synced clients drop the task", async () => {
      const { service, prisma } = buildService();
      expect(await service.delete("user-1", "task-1")).toBe(true);
      expect(prisma.syncTombstone.createMany).toHaveBeenCalledWith({
        data: [{ userId: "user-1", collection: "task", objectId: "task-1" }],
        skipDuplicates: true,
      });
    });

    it("records no tombstone when nothing was deleted", async () => {
      const { service, prisma } = buildService({ deleteCount: 0 });
      expect(await service.delete("user-1", "foreign-task")).toBe(false);
      expect(prisma.syncTombstone.createMany).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("caps the task page instead of reading the table unbounded", async () => {
      const { service, prisma } = buildService();

      await service.list("user-1");

      expect(prisma.userTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500 }),
      );
    });
  });
});
