-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaymentObligation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerContact" TEXT,
    "originalAmountPaise" INTEGER NOT NULL,
    "outstandingAmountPaise" INTEGER NOT NULL,
    "refundedAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "excessPaidAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATETIME,
    "resolvedAt" DATETIME,
    "resolutionSource" TEXT,
    CONSTRAINT "PaymentObligation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PaymentObligation" ("createdAt", "currency", "customerContact", "customerId", "dueDate", "id", "merchantId", "originalAmountPaise", "outstandingAmountPaise", "referenceId", "referenceType", "refundedAmountPaise", "resolutionSource", "resolvedAt", "status") SELECT "createdAt", "currency", "customerContact", "customerId", "dueDate", "id", "merchantId", "originalAmountPaise", "outstandingAmountPaise", "referenceId", "referenceType", "refundedAmountPaise", "resolutionSource", "resolvedAt", "status" FROM "PaymentObligation";
DROP TABLE "PaymentObligation";
ALTER TABLE "new_PaymentObligation" RENAME TO "PaymentObligation";
CREATE INDEX "PaymentObligation_merchantId_status_idx" ON "PaymentObligation"("merchantId", "status");
CREATE UNIQUE INDEX "PaymentObligation_merchantId_referenceType_referenceId_key" ON "PaymentObligation"("merchantId", "referenceType", "referenceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
