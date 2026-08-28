import { db } from "@/lib/db";

// Clears state between tests. Deletion order respects FK constraints.
export async function resetDb() {
  await db.recoveryAction.deleteMany();
  await db.recoveryCase.deleteMany();
  await db.paymentAttempt.deleteMany();
  await db.paymentObligation.deleteMany();
  await db.externalEvent.deleteMany();
  await db.auditLog.deleteMany();
  await db.merchant.deleteMany();
}

export async function createMerchant(
  overrides: Partial<{
    maxAutoRetries: number;
    maxMessagesPerCase: number;
    minMessageGapHours: number;
    autoApproveUnderPaise: number;
    contactWindowStartHour: number;
    contactWindowEndHour: number;
  }> = {}
) {
  return db.merchant.create({
    data: {
      name: "Test Merchant",
      email: `merchant-${Math.random().toString(36).slice(2)}@test.local`,
      passwordHash: "test-fixture-not-a-real-hash",
      termsAcceptedAt: new Date(),
      contactWindowStartHour: 0,
      contactWindowEndHour: 24,
      ...overrides,
    },
  });
}
