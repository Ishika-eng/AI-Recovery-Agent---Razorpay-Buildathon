import { PrismaClient } from "@/generated/prisma";

// Standard Next.js dev-mode singleton — prevents exhausting SQLite
// connections across hot reloads.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
