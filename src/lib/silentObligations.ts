import { db } from "@/lib/db";
import { runRecoveryCycle } from "@/lib/engine";

// Every recovery trigger built so far reacts to something a provider
// actually reported: a failed attempt, a dispute, a refund. But a real
// share of lost revenue never produces a provider event at all —
//
//   - a checkout gets opened and abandoned before the customer ever
//     submits a payment method, so there is no failed attempt to react to
//     ("checkout drop-off" — the whole reason classifyFailure() has a
//     USER_DROPOFF category, which until now had no real trigger: neither
//     provider adapter ever calls it with hadPaymentAttempt: false),
//   - a B2B invoice (referenceType "INVOICE", with a dueDate) simply sits
//     unpaid with nobody ever attempting to pay it at all — "everything
//     is triggered by a provider payment-failure event" is exactly the
//     gap this closes.
//
// Both cases share the same underlying shape: an obligation with zero
// PaymentAttempt rows that's gone quiet past some threshold. What differs
// is only how long "quiet" means something, and how it's framed.
const CHECKOUT_ABANDON_MS = 30 * 60 * 1000; // 30 minutes with no attempt at all

export async function detectSilentObligations(merchantId?: string) {
  const now = new Date();
  const candidates = await db.paymentObligation.findMany({
    where: {
      ...(merchantId ? { merchantId } : {}),
      status: { in: ["UNPAID", "PENDING"] },
      attempts: { none: {} },
      recoveryCase: null,
    },
  });

  let triggered = 0;
  for (const obligation of candidates) {
    const isOverdueReceivable = obligation.dueDate !== null && obligation.dueDate.getTime() < now.getTime();
    const isAbandonedCheckout =
      obligation.dueDate === null && now.getTime() - obligation.createdAt.getTime() > CHECKOUT_ABANDON_MS;

    if (!isOverdueReceivable && !isAbandonedCheckout) continue;

    // A synthetic marker, not a real provider-reported attempt — there is
    // no PaymentAttempt to record because none was ever made. This is
    // what lets runRecoveryCycle's existing paymentHistory-driven AI
    // logic reason about "zero attempts, gone silent" through the same
    // code path as every other failure category, instead of a parallel
    // one. `provider: "external"` and `status: "FAILED"` mirror how
    // resolveExternalPayment already represents non-provider-reported
    // events on the success side.
    await db.paymentAttempt.create({
      data: {
        obligationId: obligation.id,
        provider: "external",
        amountPaise: obligation.outstandingAmountPaise,
        status: "FAILED",
        failureCategory: isOverdueReceivable ? "RECEIVABLE_OVERDUE" : "USER_DROPOFF",
        failureReason: isOverdueReceivable
          ? `Invoice due date (${obligation.dueDate?.toISOString()}) passed with no payment attempt on record.`
          : "No payment attempt was ever recorded against this checkout.",
      },
    });

    await runRecoveryCycle(obligation.id);
    triggered++;
  }

  return { checked: candidates.length, triggered };
}
