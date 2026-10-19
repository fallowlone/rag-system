import { NotificationsService } from "./notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { TelegramService } from "../telegram/telegram.service";
import { DeadlineService } from "../deadlines/deadline.service";
import { UserMemoryService } from "../memory/user-memory.service";

describe("NotificationsService deadline backfill (resume-safe)", () => {
  function buildService(options?: {
    markerExists?: boolean;
    facts?: Array<{ id: string; content: string }>;
    docs?: Array<{ id: string; fileName: string | null; expiryDate: Date }>;
    saveDeadlinesFromMemory?: jest.Mock;
    saveDeadlinesFromDocument?: jest.Mock;
    rememberMock?: jest.Mock;
  }) {
    const findFirstMock = jest
      .fn()
      .mockResolvedValue(options?.markerExists ? { id: "marker-1" } : null);
    const createMock = jest.fn().mockResolvedValue({ id: "marker-new" });
    const prisma = {
      userMemory: {
        findFirst: findFirstMock,
        findMany: jest.fn().mockResolvedValue(options?.facts ?? []),
        create: createMock,
      },
      userDocument: {
        findMany: jest.fn().mockResolvedValue(options?.docs ?? []),
      },
    } as unknown as PrismaService;

    const cache = {} as unknown as CacheService;
    const telegram = {} as unknown as TelegramService;
    const deadlines = {
      saveDeadlinesFromMemory:
        options?.saveDeadlinesFromMemory ?? jest.fn().mockResolvedValue(true),
      saveDeadlinesFromDocument:
        options?.saveDeadlinesFromDocument ?? jest.fn().mockResolvedValue(true),
    } as unknown as DeadlineService;
    const userMemory = {
      remember: options?.rememberMock ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as UserMemoryService;

    const service = new NotificationsService(
      prisma,
      cache,
      telegram,
      deadlines,
      userMemory,
    );

    return { service, findFirstMock, createMock, deadlines, userMemory };
  }

  function backfill(service: NotificationsService, userId: string): Promise<void> {
    return (
      service as unknown as {
        backfillDeadlinesForUser(userId: string): Promise<void>;
      }
    ).backfillDeadlinesForUser(userId);
  }

  it("skips entirely when the completion marker already exists", async () => {
    const { service, findFirstMock, createMock, deadlines, userMemory } =
      buildService({
        markerExists: true,
      });

    await backfill(service, "user-1");

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          type: "preference",
          content: "deadline_backfill:done",
        },
      }),
    );
    expect(deadlines.saveDeadlinesFromMemory).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(userMemory.remember).not.toHaveBeenCalled();
  });

  it("runs the full scan and writes the completion marker when none exists yet", async () => {
    const facts = [{ id: "m1", content: "Termin am 5. Mai" }];
    const docs = [
      { id: "d1", fileName: "visa.pdf", expiryDate: new Date("2026-05-05") },
    ];
    const { service, createMock, deadlines, userMemory } = buildService({
      facts,
      docs,
    });

    await backfill(service, "user-1");

    expect(deadlines.saveDeadlinesFromMemory).toHaveBeenCalledWith(
      "user-1",
      "m1",
      "Termin am 5. Mai",
    );
    expect(deadlines.saveDeadlinesFromDocument).toHaveBeenCalledWith(
      "user-1",
      "d1",
      docs[0]!.expiryDate,
      "visa.pdf",
    );
    // Plain row write, not remember(): no wasted embedding call and no
    // deadline-extraction side effect for a fixed marker string.
    expect(createMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        type: "preference",
        content: "deadline_backfill:done",
      },
    });
    expect(userMemory.remember).not.toHaveBeenCalled();
  });

  it("withholds the completion marker when a save reports failure (resume-safe)", async () => {
    // The save methods never throw — they report per-item failure as false.
    // A rejection-mocking test here would assert behavior the real code
    // cannot produce (false confidence); assert on the real contract.
    const facts = [
      { id: "m1", content: "first fact" },
      { id: "m2", content: "second fact" },
    ];
    const saveDeadlinesFromMemory = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { service, createMock } = buildService({
      facts,
      saveDeadlinesFromMemory,
    });

    // A mid-backfill DB blip resolves (not throws) — but the marker stays
    // unset so a retry on next restart processes everything again.
    await expect(backfill(service, "user-1")).resolves.toBeUndefined();

    expect(createMock).not.toHaveBeenCalled();
  });

  it("scans facts concurrently instead of one serial round trip per fact", async () => {
    const facts = [
      { id: "m1", content: "first fact" },
      { id: "m2", content: "second fact" },
      { id: "m3", content: "third fact" },
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const saveDeadlinesFromMemory = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
    });
    const { service } = buildService({ facts, saveDeadlinesFromMemory });

    await backfill(service, "user-1");

    expect(saveDeadlinesFromMemory).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("NotificationsService.runHealthCheck alert dedup", () => {
  function buildHealthService(options?: {
    dbOk?: boolean;
    redisGet?: () => Promise<string | null>;
    redisSet?: jest.Mock;
    redisDel?: jest.Mock;
  }) {
    const prisma = {
      $queryRaw: options?.dbOk === false
        ? jest.fn().mockRejectedValue(new Error("db down"))
        : jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as PrismaService;
    const setMock =
      options?.redisSet ?? jest.fn().mockResolvedValue(undefined);
    const cache = {
      get:
        options?.redisGet ??
        (jest.fn().mockRejectedValue(new Error("Redis down")) as jest.Mock),
      set: setMock,
      del: options?.redisDel ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const sendToOwner = jest.fn().mockResolvedValue(undefined);
    const telegram = { sendToOwner } as unknown as TelegramService;
    const service = new NotificationsService(
      prisma,
      cache,
      telegram,
      {} as DeadlineService,
      {} as UserMemoryService,
    );
    return { service, sendToOwner, setMock };
  }

  it("still notifies (once) when the dedup-flag write fails", async () => {
    // Redis down: get throws (no prior alert) and set throws. The alert
    // must still go out exactly once and the run must not throw (a throw
    // here meant an owner alert on every 5-minute tick).
    const setMock = jest.fn().mockRejectedValue(new Error("Redis down"));
    const { service, sendToOwner } = buildHealthService({ redisSet: setMock });

    await expect(service.runHealthCheck()).resolves.toBeUndefined();

    expect(sendToOwner).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the Telegram alert send itself fails", async () => {
    // DB down + Telegram hiccup: the send must degrade to a log line, never
    // to a cron throw (fail-fast exit would take the bot down over a
    // monitoring side effect).
    const sendToOwner = jest.fn().mockRejectedValue(new Error("tg 500"));
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error("db down")),
    } as unknown as PrismaService;
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const service = new NotificationsService(
      prisma,
      cache,
      { sendToOwner } as unknown as TelegramService,
      {} as DeadlineService,
      {} as UserMemoryService,
    );

    await expect(service.runHealthCheck()).resolves.toBeUndefined();
    expect(sendToOwner).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationsService.runDeadlineTracker single-flight", () => {
  function buildTrackerService(lockOwned: boolean) {
    const setJsonNx = jest.fn().mockResolvedValue(lockOwned);
    const cache = { setJsonNx } as unknown as CacheService;
    const sendToUser = jest.fn().mockResolvedValue(undefined);
    const telegram = { sendToUser } as unknown as TelegramService;
    const service = new NotificationsService(
      {} as PrismaService,
      cache,
      telegram,
      {} as DeadlineService,
      {} as UserMemoryService,
    );
    return { service, setJsonNx, sendToUser };
  }

  it("skips the run when another replica owns the tracker lock", async () => {
    const { service, setJsonNx, sendToUser } = buildTrackerService(false);

    await service.runDeadlineTracker();

    expect(setJsonNx).toHaveBeenCalledWith(
      "cronlock:deadline-tracker",
      expect.objectContaining({ at: expect.any(String) }),
      600,
    );
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it("acquires the lock before running", async () => {
    const { service, setJsonNx } = buildTrackerService(true);

    await service.runDeadlineTracker();

    expect(setJsonNx).toHaveBeenCalledWith(
      "cronlock:deadline-tracker",
      expect.objectContaining({ at: expect.any(String) }),
      600,
    );
  });
});

describe("NotificationsService deadline reminder delivery", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OWNER_TELEGRAM_ID: "42" };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildService(
    deadlines: Array<{ label: string; daysLeft: number }>,
    sendToUser: jest.Mock,
  ) {
    const cache = {
      setJsonNx: jest.fn().mockResolvedValue(true),
    } as unknown as CacheService;
    const telegram = { sendToUser } as unknown as TelegramService;
    const deadlineService = {
      getUpcomingDeadlines: jest.fn().mockResolvedValue(
        deadlines.map((d, i) => ({
          id: `dl-${i}`,
          userId: "42",
          label: d.label,
          deadlineDate: new Date("2026-10-01T00:00:00.000Z"),
          sourceType: "document",
          sourceId: `doc-${i}`,
          daysLeft: d.daysLeft,
        })),
      ),
    } as unknown as DeadlineService;
    const userMemory = {
      getUserLanguage: jest.fn().mockResolvedValue("de"),
    } as unknown as UserMemoryService;

    return new NotificationsService(
      {} as PrismaService,
      cache,
      telegram,
      deadlineService,
      userMemory,
    );
  }

  it("escapes document-derived labels so an ampersand cannot kill the whole reminder", async () => {
    // Labels come from document text (buildDeadlineLabel slices around a
    // matched date; the app path takes them straight from the local model).
    // Unescaped, "Meier & Partner GmbH" made Telegram reject the message as
    // unparseable HTML, sendToUser swallowed the 400, and the user's daily
    // reminder simply never arrived.
    const sendToUser = jest.fn().mockResolvedValue(true);
    const service = buildService(
      [{ label: "Kündigung Meier & Partner <GmbH>", daysLeft: 3 }],
      sendToUser,
    );

    await service.runDeadlineTracker();

    expect(sendToUser).toHaveBeenCalledTimes(1);
    const sent = sendToUser.mock.calls[0]![1] as string;
    expect(sent).toContain("Meier &amp; Partner &lt;GmbH&gt;");
    expect(sent).not.toContain("Meier & Partner <GmbH>");
  });

  it("splits a reminder that exceeds Telegram's message limit", async () => {
    // getUpcomingDeadlines is capped at 200 rows, far past 4096 chars — an
    // over-long message was the same silent loss by a different route.
    const many = Array.from({ length: 120 }, (_, i) => ({
      label: `Sehr lange Fristbezeichnung Nummer ${i} mit viel Text drumherum`,
      daysLeft: i % 30,
    }));
    const sendToUser = jest.fn().mockResolvedValue(true);
    const service = buildService(many, sendToUser);

    await service.runDeadlineTracker();

    expect(sendToUser.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendToUser.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(4096);
    }
  });

  it("reports a reminder that did not reach the user instead of swallowing it", async () => {
    const sendToUser = jest.fn().mockResolvedValue(false);
    const service = buildService([{ label: "Frist", daysLeft: 2 }], sendToUser);
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    await service.runDeadlineTracker();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("0/1 message part(s) delivered"),
    );
  });
});
