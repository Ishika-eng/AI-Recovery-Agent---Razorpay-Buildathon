import { db } from "@/lib/db";

// PRD Problem 30: a genuine customer fails a payment once, maybe twice —
// a wrong CVV, an expired card, a bank decline. Several distinct payment
// attempts against the *same* obligation within a few minutes looks like
// something else: card testing, someone iterating through stolen card
// numbers against a single order to find one that clears. The right
// response isn't "keep offering a payment link" — that just hands the
// attacker more attempts — it's to stop automated recovery and put a
// human in the loop until it's cleared.
const VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const VELOCITY_MIN_ATTEMPTS = 5;

export type FraudSignal = {
  suspected: boolean;
  attemptCount: number;
  windowMinutes: number;
};

export async function detectSuspiciousVelocity(obligationId: string): Promise<FraudSignal> {
  const windowMinutes = VELOCITY_WINDOW_MS / 60_000;
  const since = new Date(Date.now() - VELOCITY_WINDOW_MS);

  const attemptCount = await db.paymentAttempt.count({
    where: { obligationId, status: "FAILED", createdAt: { gte: since } },
  });

  return { suspected: attemptCount >= VELOCITY_MIN_ATTEMPTS, attemptCount, windowMinutes };
}
