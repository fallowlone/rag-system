import { z } from "zod";

/**
 * Single source of truth for required/optional environment variables,
 * replacing the previous pattern of each of ~9 service constructors
 * independently throwing "X is not set" the first time it happened to run
 * — which meant a deploy missing several vars only surfaced them one at a
 * time, in whatever order Nest happened to instantiate providers.
 *
 * ADMIN_API_TOKEN / RAG_BOT_SECRET are intentionally optional here: both
 * guards (AdminAuthGuard, DocvaultAuthGuard) already fail closed — reject
 * every request — when unset, so an app without those configured still
 * boots; only the admin/docvault HTTP surface is unreachable. Requiring
 * them at startup would turn that safe degrade into a hard crash.
 */
export const EnvSchema = z.object({
    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required (Prisma connection string)"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required (BullMQ + cache)"),
    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),

    LOCAL_RETRIEVAL_URL: z.url("LOCAL_RETRIEVAL_URL must be a valid URL"),
    LOCAL_RETRIEVAL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(30_000)
      .optional(),
    LOCAL_RETRIEVAL_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .optional(),

    PORT: z.string().optional(),
    OWNER_TELEGRAM_ID: z.string().optional(),
    ALLOWED_TELEGRAM_IDS: z.string().optional(),
    ADMIN_API_TOKEN: z.string().optional(),
    RAG_BOT_SECRET: z.string().optional(),
    /** Public bot @username (without @) so the macOS app can deep-link the
     *  bot chat for reverse pairing. Optional: when unset the app falls back
     *  to copy-paste. */
    TELEGRAM_BOT_USERNAME: z.string().optional(),
  });

export interface EnvCheckResult {
  errors: string[];
  warnings: string[];
}

/**
 * Pure validation — returns human-readable error/warning lines instead of
 * throwing or exiting, so callers (and tests) control the effect.
 */
export function checkEnv(env: NodeJS.ProcessEnv): EnvCheckResult {
  const result = EnvSchema.safeParse(env);
  const errors = result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

  const warnings: string[] = [];
  if (!env.ADMIN_API_TOKEN) {
    warnings.push(
      "ADMIN_API_TOKEN is not set — /admin/* endpoints will reject all requests.",
    );
  }
  if (!env.RAG_BOT_SECRET) {
    warnings.push(
      "RAG_BOT_SECRET is not set — /admin/docvault/* endpoints will reject all requests.",
    );
  }

  return { errors, warnings };
}
