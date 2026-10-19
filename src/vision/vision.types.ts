/** Supported image inputs for Sonnet vision transcription. */
export type VisionMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

/**
 * Anthropic's per-image ceiling on the direct Claude API is 10 MB applied to
 * the BASE64 payload, not to the file on disk. (5 MB is the Amazon Bedrock /
 * Google Cloud figure; this project calls the Claude API directly.)
 */
export const VISION_MAX_BASE64_BYTES = 10 * 1024 * 1024;

/**
 * The same ceiling expressed in raw bytes, which is what callers actually
 * hold. Base64 inflates by 4/3, so comparing a raw length against the
 * base64 limit is an apples-to-oranges check: the previous constant was both
 * the wrong number (Bedrock's) and the wrong unit, and between them they
 * rejected ordinary phone photos the API would have accepted.
 *
 * Larger photos are rejected with a user-facing message, never rescaled
 * server-side.
 */
export const VISION_MAX_IMAGE_BYTES = Math.floor(
  (VISION_MAX_BASE64_BYTES * 3) / 4,
);

/** For user-facing copy — keeps the message and the bound in one place. */
export const VISION_MAX_IMAGE_MB = Math.floor(
  VISION_MAX_IMAGE_BYTES / (1024 * 1024),
);

export const VISION_TRANSCRIBE_MAX_TOKENS = 4000;
