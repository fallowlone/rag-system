import { ConversationBlock } from "./batch.types";

const SESSION_GAP_MS = 15 * 60 * 1_000; // 15 minutes
const MAX_BLOCK_MESSAGES = 80;

interface RawMessage {
  role: string;
  content: string;
  createdAt: Date;
}

/**
 * Pure helper. Splits a chronologically-sorted message list into "session"
 * blocks. A new block starts whenever the gap to the previous message is at
 * least SESSION_GAP_MS, or when the current block would exceed
 * MAX_BLOCK_MESSAGES (forced split keeps Sonnet input bounded).
 */
export function splitIntoBlocks(messages: RawMessage[]): ConversationBlock[] {
  if (messages.length === 0) return [];

  const blocks: ConversationBlock[] = [];
  let current: RawMessage[] = [messages[0]!];

  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1]!;
    const curr = messages[i]!;
    const gap = curr.createdAt.getTime() - prev.createdAt.getTime();

    const tooBig = current.length >= MAX_BLOCK_MESSAGES;
    const newSession = gap >= SESSION_GAP_MS;

    if (tooBig || newSession) {
      blocks.push(toBlock(current));
      current = [curr];
    } else {
      current.push(curr);
    }
  }

  if (current.length > 0) {
    blocks.push(toBlock(current));
  }

  return blocks;
}

function toBlock(messages: RawMessage[]): ConversationBlock {
  return {
    startedAt: messages[0]!.createdAt,
    endedAt: messages[messages.length - 1]!.createdAt,
    messages,
  };
}
