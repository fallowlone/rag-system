import { HttpException } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import { LocalRetrievalHealthService } from "./local-retrieval-health.service";

describe("HealthController", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      ANTHROPIC_API_KEY: "test-key",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildController(options?: {
    dbOk?: boolean;
    redisOk?: boolean;
    modelsListMock?: jest.Mock;
    retrievalOk?: boolean;
  }) {
    const prisma = {
      $queryRaw: options?.dbOk === false
        ? jest.fn().mockRejectedValue(new Error("db down"))
        : jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as PrismaService;
    const cache = {
      ping: options?.redisOk === false
        ? jest.fn().mockRejectedValue(new Error("redis down"))
        : jest.fn().mockResolvedValue("PONG"),
    } as unknown as CacheService;

    const retrievalHealth = {
      ping: jest
        .fn()
        .mockResolvedValue(options?.retrievalOk === false ? "down" : "ok"),
    } as unknown as LocalRetrievalHealthService;
    const controller = new HealthController(prisma, cache, retrievalHealth);
    (
      controller as unknown as { anthropic: { models: { list: jest.Mock } } }
    ).anthropic = {
      models: {
        list: options?.modelsListMock ?? jest.fn().mockResolvedValue({ data: [] }),
      },
    };
    return { controller, retrievalHealth };
  }

  describe("ready", () => {
    it("checks db, redis, and the pinned local retrieval service without calling Anthropic", async () => {
      const modelsListMock = jest.fn();
      const { controller, retrievalHealth } = buildController({ modelsListMock });

      const result = await controller.ready();

      expect(result).toEqual({ status: "ok" });
      expect(modelsListMock).not.toHaveBeenCalled();
      expect(retrievalHealth.ping).toHaveBeenCalledTimes(1);
    });

    it("returns 503 when redis is down", async () => {
      const { controller } = buildController({ redisOk: false });
      await expect(controller.ready()).rejects.toThrow(HttpException);
    });

    it("returns 503 when the local retrieval service is down", async () => {
      const { controller } = buildController({ retrievalOk: false });
      await expect(controller.ready()).rejects.toThrow(HttpException);
    });
  });

  describe("detailed", () => {
    it("reports ok for all four dependencies when everything is reachable", async () => {
      const { controller } = buildController();

      const result = await controller.checkDetailed();

      expect(result).toEqual({
        status: "ok",
        db: "ok",
        redis: "ok",
        anthropic: "ok",
        retrieval: "ok",
      });
    });

    it("marks status down and reports anthropic:down when Anthropic is unreachable, without affecting the others", async () => {
      const { controller } = buildController({
        modelsListMock: jest.fn().mockRejectedValue(new Error("401 unauthorized")),
      });

      await expect(controller.checkDetailed()).rejects.toMatchObject({
        response: {
          status: "down",
          db: "ok",
          redis: "ok",
          anthropic: "down",
          retrieval: "ok",
        },
      });
    });

    it("marks status down and reports retrieval:down when the local retrieval service is unreachable", async () => {
      const { controller } = buildController({
        retrievalOk: false,
      });

      await expect(controller.checkDetailed()).rejects.toMatchObject({
        response: { status: "down", retrieval: "down", anthropic: "ok" },
      });
    });
  });
});
