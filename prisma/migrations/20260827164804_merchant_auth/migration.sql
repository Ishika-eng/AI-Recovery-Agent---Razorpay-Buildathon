/*
  Warnings:

  - Added the required column `passwordHash` to the `Merchant` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termsAcceptedAt" DATETIME,
    "maxAutoRetries" INTEGER NOT NULL DEFAULT 3,
    "maxMessagesPerCase" INTEGER NOT NULL DEFAULT 3,
    "minMessageGapHours" INTEGER NOT NULL DEFAULT 24,
    "autoApproveUnderPaise" INTEGER NOT NULL DEFAULT 500000,
    "contactWindowStartHour" INTEGER NOT NULL DEFAULT 9,
    "contactWindowEndHour" INTEGER NOT NULL DEFAULT 20
);
INSERT INTO "new_Merchant" ("autoApproveUnderPaise", "contactWindowEndHour", "contactWindowStartHour", "createdAt", "email", "id", "maxAutoRetries", "maxMessagesPerCase", "minMessageGapHours", "name") SELECT "autoApproveUnderPaise", "contactWindowEndHour", "contactWindowStartHour", "createdAt", "email", "id", "maxAutoRetries", "maxMessagesPerCase", "minMessageGapHours", "name" FROM "Merchant";
DROP TABLE "Merchant";
ALTER TABLE "new_Merchant" RENAME TO "Merchant";
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
