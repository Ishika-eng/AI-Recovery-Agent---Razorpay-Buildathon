-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maxAutoRetries" INTEGER NOT NULL DEFAULT 3,
    "maxMessagesPerCase" INTEGER NOT NULL DEFAULT 3,
    "minMessageGapHours" INTEGER NOT NULL DEFAULT 24,
    "autoApproveUnderPaise" INTEGER NOT NULL DEFAULT 500000,
    "contactWindowStartHour" INTEGER NOT NULL DEFAULT 9,
    "contactWindowEndHour" INTEGER NOT NULL DEFAULT 20
);

-- CreateTable
CREATE TABLE "PaymentObligation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerContact" TEXT,
    "originalAmountPaise" INTEGER NOT NULL,
    "outstandingAmountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATETIME,
    "resolvedAt" DATETIME,
    "resolutionSource" TEXT,
    CONSTRAINT "PaymentObligation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "providerEventId" TEXT,
    "paymentMethod" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "failureCategory" TEXT,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentAttempt_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecoveryCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "strategy" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'STANDARD',
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "nextAction" TEXT,
    "nextActionAt" DATETIME,
    "contactOptedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "RecoveryCase_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "PaymentObligation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecoveryAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL DEFAULT 'AI',
    "reason" TEXT NOT NULL,
    "policyResult" TEXT,
    "policyReasoning" TEXT,
    "executionStatus" TEXT NOT NULL DEFAULT 'PROPOSED',
    "recoveredPaise" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    "executedAt" DATETIME,
    CONSTRAINT "RecoveryAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExternalEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "idempotencyStatus" TEXT NOT NULL DEFAULT 'PROCESSED',
    "rawPayload" TEXT NOT NULL,
    CONSTRAINT "ExternalEvent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

-- CreateIndex
CREATE INDEX "PaymentObligation_merchantId_status_idx" ON "PaymentObligation"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentObligation_merchantId_referenceType_referenceId_key" ON "PaymentObligation"("merchantId", "referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_obligationId_idx" ON "PaymentAttempt"("obligationId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_provider_providerPaymentId_idx" ON "PaymentAttempt"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCase_obligationId_key" ON "RecoveryCase"("obligationId");

-- CreateIndex
CREATE INDEX "RecoveryCase_status_idx" ON "RecoveryCase"("status");

-- CreateIndex
CREATE INDEX "RecoveryAction_caseId_idx" ON "RecoveryAction"("caseId");

-- CreateIndex
CREATE INDEX "RecoveryAction_executionStatus_idx" ON "RecoveryAction"("executionStatus");

-- CreateIndex
CREATE INDEX "ExternalEvent_merchantId_receivedAt_idx" ON "ExternalEvent"("merchantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEvent_provider_externalEventId_key" ON "ExternalEvent"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_createdAt_idx" ON "AuditLog"("merchantId", "createdAt");
