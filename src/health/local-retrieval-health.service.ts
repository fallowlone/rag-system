import { Injectable, Logger } from "@nestjs/common";
import { assertLocalRetrievalServiceReady } from "../ingestion/local-embedding-cutover";

export type LocalRetrievalHealthStatus = "ok" | "down";

@Injectable()
export class LocalRetrievalHealthService {
  private readonly logger = new Logger(LocalRetrievalHealthService.name);

  async ping(): Promise<LocalRetrievalHealthStatus> {
    try {
      await assertLocalRetrievalServiceReady();
      return "ok";
    } catch (err) {
      this.logger.warn(
        `Local retrieval health check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "down";
    }
  }
}
