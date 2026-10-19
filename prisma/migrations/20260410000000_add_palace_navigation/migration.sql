-- CreateTable
CREATE TABLE "Wing" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Wing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wingId" TEXT NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tunnel" (
    "roomAId" TEXT NOT NULL,
    "roomBId" TEXT NOT NULL,

    CONSTRAINT "Tunnel_pkey" PRIMARY KEY ("roomAId","roomBId")
);

-- AlterTable
ALTER TABLE "LawChunk" ADD COLUMN "roomId" TEXT;

-- AddForeignKey
ALTER TABLE "LawChunk" ADD CONSTRAINT "LawChunk_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_wingId_fkey" FOREIGN KEY ("wingId") REFERENCES "Wing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tunnel" ADD CONSTRAINT "Tunnel_roomAId_fkey" FOREIGN KEY ("roomAId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tunnel" ADD CONSTRAINT "Tunnel_roomBId_fkey" FOREIGN KEY ("roomBId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
