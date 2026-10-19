import { Prisma } from "@prisma/client";

export function embeddingColumnSql(alias?: "m"): Prisma.Sql {
  if (alias === "m") {
    return Prisma.sql`m."embeddingBge"`;
  }

  return Prisma.sql`"embeddingBge"`;
}
