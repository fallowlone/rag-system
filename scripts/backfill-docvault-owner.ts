/**
 * One-off backfill: existing docvault chunks (LawChunk.lawId = 'docvault')
 * predate the ownerUserId column and were all ingested for the bot's owner.
 * Assigns OWNER_TELEGRAM_ID to any docvault chunk still missing an owner.
 *
 * Run:
 *   npx ts-node scripts/backfill-docvault-owner.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const ownerUserId = process.env.OWNER_TELEGRAM_ID?.trim();
  if (!ownerUserId) {
    throw new Error("OWNER_TELEGRAM_ID is not set — cannot backfill docvault owner");
  }

  console.log(`Backfilling docvault chunks with ownerUserId=${ownerUserId}...`);

  const result = await prisma.$executeRaw`
    UPDATE "LawChunk"
    SET "ownerUserId" = ${ownerUserId}
    WHERE "lawId" = 'docvault' AND "ownerUserId" IS NULL
  `;

  console.log(`Done. ${result} docvault chunk(s) updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
