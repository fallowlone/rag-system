import { Logger } from "@nestjs/common";
import { checkEnv } from "./env.schema";

// Side-effect module: imported before ./app.module in main.ts so a missing
// or invalid env var exits with one clear, aggregated message before any
// Nest provider (whose constructor would otherwise throw on first use, at
// an unpredictable point in the boot sequence) gets a chance to run.
const logger = new Logger("EnvValidation");
const { errors, warnings } = checkEnv(process.env);

for (const warning of warnings) {
  logger.warn(warning);
}

if (errors.length > 0) {
  logger.error(
    `Invalid environment configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
  process.exit(1);
}
