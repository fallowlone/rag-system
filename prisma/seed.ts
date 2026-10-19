import { PrismaClient } from "@prisma/client";
import { resolveRoomForLaw } from "../src/ingestion/law-room-map";

const prisma = new PrismaClient();

const WINGS = [
  { id: "german_law", name: "German Law" },
  { id: "user_documents", name: "User Documents" },
];

const ROOMS = [
  // german_law wing
  { id: "mietrecht", name: "Mietrecht", wingId: "german_law" },
  { id: "sozialrecht", name: "Sozialrecht", wingId: "german_law" },
  { id: "auslaenderrecht", name: "Ausländerrecht", wingId: "german_law" },
  { id: "strafrecht", name: "Strafrecht", wingId: "german_law" },
  { id: "general_law", name: "Allgemeines", wingId: "german_law" },
  // user_documents wing
  { id: "mietvertrag", name: "Mietvertrag", wingId: "user_documents" },
  { id: "jobcenter", name: "Jobcenter", wingId: "user_documents" },
  { id: "visa", name: "Visa / Aufenthalt", wingId: "user_documents" },
  { id: "versicherung", name: "Versicherung", wingId: "user_documents" },
  { id: "bank", name: "Bank / Finanzen", wingId: "user_documents" },
  { id: "other_docs", name: "Sonstiges", wingId: "user_documents" },
];

// Tunnels connect user_documents rooms to german_law rooms
const TUNNELS = [
  { roomAId: "mietvertrag", roomBId: "mietrecht" },
  { roomAId: "jobcenter", roomBId: "sozialrecht" },
  { roomAId: "visa", roomBId: "auslaenderrecht" },
  { roomAId: "versicherung", roomBId: "general_law" },
  { roomAId: "bank", roomBId: "general_law" },
];

async function main(): Promise<void> {
  console.log("Seeding wings...");
  for (const wing of WINGS) {
    await prisma.wing.upsert({
      where: { id: wing.id },
      update: { name: wing.name },
      create: wing,
    });
  }

  console.log("Seeding rooms...");
  for (const room of ROOMS) {
    await prisma.room.upsert({
      where: { id: room.id },
      update: { name: room.name, wingId: room.wingId },
      create: room,
    });
  }

  console.log("Seeding tunnels...");
  for (const tunnel of TUNNELS) {
    await prisma.tunnel.upsert({
      where: { roomAId_roomBId: tunnel },
      update: {},
      create: tunnel,
    });
  }

  // Backfill roomId for existing LawChunk rows (laws only, not docvault)
  console.log("Backfilling roomId for existing law chunks...");
  const laws = await prisma.law.findMany({
    where: { id: { not: "docvault" } },
    select: { id: true },
  });

  for (const law of laws) {
    const roomId = resolveRoomForLaw(law.id);
    const result = await prisma.$executeRaw`
      UPDATE "LawChunk"
      SET "roomId" = ${roomId}
      WHERE "lawId" = ${law.id} AND "roomId" IS NULL
    `;
    if (result > 0) {
      console.log(`  ${law.id} → ${roomId} (${result} chunks)`);
    }
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
