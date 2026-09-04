import { db } from "@/lib/db";

// PRD Problem 11: a payment provider having its own outage looks, from any
// single obligation's point of view, identical to "this customer's payment
// keeps failing" — a timeout or gateway error is exactly what the AI
// already treats as transient and worth a short wait. But when the *same*
// provider produces that same transient failure across many *different*
// obligations within a short window, that isn't several independent
// customer-side problems — it's the provider itself being down, and
// nudging each affected customer individually ("please try again") is
// actively misleading when nothing on their end is wrong.
const OUTAGE_WINDOW_MS = 15 * 60 * 1000;
const OUTAGE_MIN_FAILURES = 3;
const OUTAGE_MIN_DISTINCT_OBLIGATIONS = 3;
const OUTAGE_TRANSIENT_CATEGORIES = ["TIMEOUT", "NETWORK_ERROR", "GATEWAY_ERROR"] as const;

export type ProviderHealth = {
  suspectedOutage: boolean;
  affectedObligations: number;
  windowMinutes: number;
};

export async function detectProviderOutage(merchantId: string, provider: string): Promise<ProviderHealth> {
  const windowMinutes = OUTAGE_WINDOW_MS / 60_000;
  const since = new Date(Date.now() - OUTAGE_WINDOW_MS);

  const recentTransientFailures = await db.paymentAttempt.findMany({
    where: {
      provider,
      status: "FAILED",
      failureCategory: { in: [...OUTAGE_TRANSIENT_CATEGORIES] },
      createdAt: { gte: since },
      obligation: { merchantId },
    },
    select: { obligationId: true },
  });

  const affectedObligations = new Set(recentTransientFailures.map((a) => a.obligationId)).size;
  const suspectedOutage =
    recentTransientFailures.length >= OUTAGE_MIN_FAILURES && affectedObligations >= OUTAGE_MIN_DISTINCT_OBLIGATIONS;

  return { suspectedOutage, affectedObligations, windowMinutes };
}
