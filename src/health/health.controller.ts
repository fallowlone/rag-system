import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { LocalRetrievalHealthService } from "./local-retrieval-health.service";

type HealthStatus = "ok" | "down";

interface PublicHealthResponse {
  status: HealthStatus;
}

interface DetailedHealthResponse {
  status: HealthStatus;
  db: HealthStatus;
  redis: HealthStatus;
  anthropic: HealthStatus;
  retrieval: HealthStatus;
}

/**
 * `/health/detailed` only — deliberately NOT part of `/health/ready`. A K8s
 * readiness probe should reflect whether *this pod* can serve traffic;
 * restarting a pod does nothing for an Anthropic outage, and most
 * endpoints (including health itself) work fine without a live LLM call, so
 * failing readiness on a third-party API hiccup would pull healthy pods out
 * of rotation for no benefit.
 */
@Controller("health")
@SkipThrottle()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly anthropic: Anthropic;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly retrievalHealth: LocalRetrievalHealthService,
  ) {
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  @Get()
  live(): PublicHealthResponse {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<PublicHealthResponse> {
    const [db, redis, retrieval] = await Promise.all([
      this.pingDb(),
      this.pingRedis(),
      this.retrievalHealth.ping(),
    ]);
    const status: HealthStatus =
      db === "ok" && redis === "ok" && retrieval === "ok" ? "ok" : "down";
    const body: PublicHealthResponse = { status };
    if (status === "down") {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }

  @Get("detailed")
  @UseGuards(AdminAuthGuard)
  async checkDetailed(): Promise<DetailedHealthResponse> {
    const [db, redis, anthropic, retrieval] = await Promise.all([
      this.pingDb(),
      this.pingRedis(),
      this.pingAnthropic(),
      this.retrievalHealth.ping(),
    ]);
    const status: HealthStatus =
      db === "ok" && redis === "ok" && anthropic === "ok" && retrieval === "ok"
        ? "ok"
        : "down";
    const body: DetailedHealthResponse = {
      status,
      db,
      redis,
      anthropic,
      retrieval,
    };
    if (status === "down") {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }

  private async pingDb(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return "ok";
    } catch (err) {
      this.logger.warn(
        `DB ping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "down";
    }
  }

  private async pingRedis(): Promise<HealthStatus> {
    try {
      const result = await this.cache.ping();
      return result === "PONG" ? "ok" : "down";
    } catch (err) {
      this.logger.warn(
        `Redis ping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "down";
    }
  }

  // Anthropic has no dedicated ping endpoint; models.list is metadata-only
  // (no token billing) and still exercises real auth + network connectivity.
  private async pingAnthropic(): Promise<HealthStatus> {
    try {
      await this.anthropic.models.list({ limit: 1 });
      return "ok";
    } catch (err) {
      this.logger.warn(
        `Anthropic ping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "down";
    }
  }

}
