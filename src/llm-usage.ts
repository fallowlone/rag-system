import { Logger } from "@nestjs/common";

/**
 * Minimal structural view of Anthropic's usage object — accepts both
 * `Message.usage` and the accumulated usage of a streamed response.
 */
export interface LlmUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Structured single-line usage log for every Anthropic call.
 * Greppable via `[llm-usage]`; lets us verify prompt-caching hit rates
 * (cacheRead > 0) and attribute token spend per request type.
 */
export function logLlmUsage(
  logger: Logger,
  tag: string,
  model: string,
  usage: LlmUsageLike | undefined | null,
): void {
  if (!usage) return;
  logger.log(
    `[llm-usage] tag=${tag} model=${model} ` +
      `in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} ` +
      `cacheRead=${usage.cache_read_input_tokens ?? 0} ` +
      `cacheWrite=${usage.cache_creation_input_tokens ?? 0}`,
  );
}
