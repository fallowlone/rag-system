/**
 * `stop_reason` handling shared by every Anthropic call site.
 *
 * `refusal` was checked everywhere; `max_tokens` was checked nowhere. The
 * difference matters because a refusal is loud (empty or explicit) while a
 * budget cut is quiet: the response looks well-formed, carries real content,
 * and is a fragment. Downstream that fragment is indistinguishable from a
 * complete answer — a half-read document photo became "the facts of this
 * document", a half-written diary entry became the user's day.
 *
 * Every site that reads `response.content` should decide, explicitly, what a
 * fragment means for it. This helper exists so that decision has a name and
 * so new call sites are greppable.
 */
export function hitOutputBudget(response: {
  stop_reason?: string | null;
}): boolean {
  return response.stop_reason === "max_tokens";
}
