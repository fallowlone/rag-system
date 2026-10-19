import "dotenv/config";
import "./config/validate-env";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { PrismaClient } from "@prisma/client";
import helmet from "helmet";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { assertLocalRetrievalCutoverReady } from "./ingestion/local-embedding-cutover";
import { GlobalExceptionFilter } from "./common/http-exception.filter";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Bootstrap");
  // A floating rejection (fire-and-forget telemetry, a missed await) must
  // crash loudly with a log line — never die silent and leave the process
  // half-alive serving traffic with broken invariants.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error(
      "Unhandled promise rejection — exiting",
      reason instanceof Error ? reason.stack : String(reason),
    );
    process.exit(1);
  });
  process.on("uncaughtException", (err: Error) => {
    logger.error("Uncaught exception — exiting", err.stack);
    process.exit(1);
  });
  const preflightPrisma = new PrismaClient();
  try {
    await assertLocalRetrievalCutoverReady(preflightPrisma);
    logger.log("Local retrieval cutover preflight verified");
  } finally {
    await preflightPrisma.$disconnect();
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(helmet());
  app.use(json({ limit: "20mb" }));
  app.use(urlencoded({ limit: "20mb", extended: true }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application running on port ${port}`);
}

bootstrap().catch((err: unknown) => {
  new Logger("Bootstrap").error("Failed to start application", err);
  process.exit(1);
});
