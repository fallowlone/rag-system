import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Per-process random key. HMAC-ing both inputs before comparing:
//  1. normalizes both inputs to a fixed-length digest, so timingSafeEqual never
//     throws on a length mismatch (and length itself never leaks via that throw);
//  2. being keyed (vs. a plain unkeyed hash) means the digests are unpredictable
//     to anyone who doesn't already know the compared secret, which is strictly
//     safer than createHash alone for a token-comparison helper.
const COMPARE_KEY = randomBytes(32);

/**
 * Constant-time string comparison for secrets/tokens (bearer tokens, admin
 * API keys, etc). Never use `===`/`!==` for comparing secrets — it short-
 * circuits on the first differing byte, leaking timing information an
 * attacker can use to brute-force the value byte-by-byte.
 */
export function safeCompare(a: string, b: string): boolean {
  const hashA = createHmac("sha256", COMPARE_KEY).update(a).digest();
  const hashB = createHmac("sha256", COMPARE_KEY).update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
