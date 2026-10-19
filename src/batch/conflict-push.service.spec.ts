import { ConflictPushService } from "./conflict-push.service";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import { TelegramService } from "../telegram/telegram.service";

function buildService(options: {
  conflicts?: Array<{
    conflictGroupId: string;
    userId: string;
    pushCount: number;
    lastPushedAt: Date;
  }>;
  members?: Array<{ id: string; content: string; createdAt: Date }>;
  sent?: boolean;
  lockOwned?: boolean;
}) {
  const pushStateUpdate = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    conflictPushState: {
      findMany: jest.fn().mockResolvedValue(options.conflicts ?? []),
      update: pushStateUpdate,
    },
    userMemory: {
      findMany: jest.fn().mockResolvedValue(options.members ?? []),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  } as unknown as PrismaService;
  const sendConflictPrompt = jest
    .fn()
    .mockResolvedValue(options.sent ?? true);
  const sendToUser = jest.fn().mockResolvedValue(undefined);
  const telegram = {
    sendConflictPrompt,
    sendToUser,
  } as unknown as TelegramService;
  const setJsonNx = jest
    .fn()
    .mockResolvedValue(options.lockOwned ?? true);
  const cache = { setJsonNx } as unknown as CacheService;
  const service = new ConflictPushService(prisma, cache, telegram);
  return {
    service,
    prisma,
    sendConflictPrompt,
    sendToUser,
    pushStateUpdate,
    setJsonNx,
  };
}

const CONFLICT = {
  conflictGroupId: "group-1",
  userId: "555",
  pushCount: 0,
  lastPushedAt: new Date("2026-01-01T00:00:00Z"),
};

const TWO_MEMBERS = [
  { id: "mem-old", content: "Alte Variante", createdAt: new Date("2026-01-01T00:00:00Z") },
  { id: "mem-new", content: "Neue Variante", createdAt: new Date("2026-01-02T00:00:00Z") },
];

describe("ConflictPushService.runMorningPush", () => {
  it("does nothing when no conflicts are pending", async () => {
    const { service, sendConflictPrompt } = buildService({});

    await service.runMorningPush();

    expect(sendConflictPrompt).not.toHaveBeenCalled();
  });

  it("skips the whole run when another replica owns the morning lock", async () => {
    const { service, sendConflictPrompt, setJsonNx } = buildService({
      conflicts: [CONFLICT],
      members: TWO_MEMBERS,
      lockOwned: false,
    });

    await service.runMorningPush();

    expect(setJsonNx).toHaveBeenCalledWith(
      "cronlock:morning-push",
      expect.objectContaining({ at: expect.any(String) }),
      600,
    );
    expect(sendConflictPrompt).not.toHaveBeenCalled();
  });

  it("resolves groups with fewer than two members without prompting", async () => {
    const { service, sendConflictPrompt, pushStateUpdate } = buildService({
      conflicts: [CONFLICT],
      members: [TWO_MEMBERS[0]!],
    });

    await service.runMorningPush();

    expect(sendConflictPrompt).not.toHaveBeenCalled();
    expect(pushStateUpdate).toHaveBeenCalledWith({
      where: { conflictGroupId: "group-1" },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it("does not burn a push attempt when Telegram delivery fails", async () => {
    const { service, sendConflictPrompt, pushStateUpdate } = buildService({
      conflicts: [CONFLICT],
      members: TWO_MEMBERS,
      sent: false,
    });

    await service.runMorningPush();

    expect(sendConflictPrompt).toHaveBeenCalledTimes(1);
    expect(pushStateUpdate).not.toHaveBeenCalled();
  });

  it("increments pushCount only after successful delivery", async () => {
    const { service, pushStateUpdate } = buildService({
      conflicts: [CONFLICT],
      members: TWO_MEMBERS,
      sent: true,
    });

    await service.runMorningPush();

    expect(pushStateUpdate).toHaveBeenCalledWith({
      where: { conflictGroupId: "group-1" },
      data: { lastPushedAt: expect.any(Date), pushCount: { increment: 1 } },
    });
  });
});

describe("ConflictPushService poison-pill guard", () => {
  it("resolves a non-numeric-userId conflict without prompting so it stops occupying the window", async () => {
    const { service, sendConflictPrompt, pushStateUpdate } = buildService({
      conflicts: [{ ...CONFLICT, userId: "not-a-number" }],
      members: TWO_MEMBERS,
    });

    await service.runMorningPush();

    expect(sendConflictPrompt).not.toHaveBeenCalled();
    expect(pushStateUpdate).toHaveBeenCalledWith({
      where: { conflictGroupId: "group-1" },
      data: { resolvedAt: expect.any(Date) },
    });
  });
});

describe("ConflictPushService autoResolve", () => {
  it("keeps the most recent fact, scopes writes to the user, and notifies them", async () => {
    const { service, prisma, sendToUser } = buildService({
      conflicts: [{ ...CONFLICT, pushCount: 3 }],
      members: TWO_MEMBERS,
    });

    await service.runMorningPush();

    // Winner = most recent member.
    expect(prisma.userMemory.update).toHaveBeenCalledWith({
      where: { id: "mem-new" },
      data: { status: "active", conflictGroupId: null },
    });
    // Losers scoped to the group AND the user.
    expect(prisma.userMemory.updateMany).toHaveBeenCalledWith({
      where: {
        conflictGroupId: "group-1",
        userId: "555",
        id: { not: "mem-new" },
      },
      data: { status: "stale", conflictGroupId: null },
    });
    // The user is told which variant survived.
    expect(sendToUser).toHaveBeenCalledWith(
      "555",
      expect.stringContaining("Neue Variante"),
    );
  });
});
