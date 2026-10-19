/**
 * Who is allowed to talk to the bot.
 *
 * Two env vars are combined into a single deduplicated list of Telegram user IDs:
 *   - OWNER_TELEGRAM_ID       — primary account (kept for admin-only channels like
 *                               health alerts and the deadline tracker in Russian).
 *   - ALLOWED_TELEGRAM_IDS    — comma-separated extra accounts (e.g. partner,
 *                               secondary device). Optional; empty means owner only.
 *
 * Every ID listed here gets full bot functionality with its own isolated data —
 * UserMemory, UserDocument, UserDeadline are all keyed by userId in the schema.
 */

export function getAllowedTelegramIds(): string[] {
  const owner = process.env.OWNER_TELEGRAM_ID?.trim();
  const extra = (process.env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const ids = new Set<string>();
  if (owner) ids.add(owner);
  for (const id of extra) ids.add(id);
  return [...ids];
}

export function isAllowedTelegramId(id: string | number): boolean {
  return getAllowedTelegramIds().includes(String(id));
}
