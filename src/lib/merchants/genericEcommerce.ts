import { db } from "@/lib/db";
import type { MerchantAdapter } from "@/lib/merchants/types";
import type { ObligationContext, ActionType } from "@/lib/types";

// GenericEcommerceAdapter — the Level-1 "generic merchant integration" from
// PRD §26/§27: a merchant using order/cart/customer vocabulary, mapped onto
// our internal PaymentObligation store. For this build the "merchant
// system" and the platform's own database happen to be the same store, but
// the point of the adapter is that the recovery engine only ever calls
// through this interface — a real e-commerce backend would implement the
// same contract over its own orders table.
export class GenericEcommerceAdapter implements MerchantAdapter {
  async getObligation(referenceType: string, referenceId: string): Promise<ObligationContext | null> {
    const obligation = await db.paymentObligation.findFirst({
      where: { referenceType, referenceId },
    });
    if (!obligation) return null;
    return this.toContext(obligation);
  }

  async getObligationStatus(obligationId: string): Promise<ObligationContext["status"]> {
    const obligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligationId } });
    return obligation.status as ObligationContext["status"];
  }

  async getCustomerContext(customerId: string) {
    // A real e-commerce adapter would read order history; here we derive a
    // plausible profile from how many obligations this customer has already
    // paid off vs. failed, so the AI layer has something real to reason on.
    const obligations = await db.paymentObligation.findMany({ where: { customerId } });
    const successfulPayments = obligations.filter((o) => o.status === "PAID").length;
    const oldest = obligations.reduce<Date | null>((min, o) => {
      return !min || o.createdAt < min ? o.createdAt : min;
    }, null);
    const relationshipAgeDays = oldest
      ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 86_400_000))
      : 0;

    const customerValue: "LOW" | "STANDARD" | "HIGH" =
      successfulPayments >= 10 ? "HIGH" : successfulPayments >= 2 ? "STANDARD" : "LOW";

    return { relationshipAgeDays, successfulPayments, customerValue };
  }

  async notifyStatusChange(_obligationId: string, _status: ObligationContext["status"]): Promise<void> {
    // In a real integration this would call the merchant's webhook/API to
    // tell their order system "this order is now PAID". Here the obligation
    // row itself *is* that system of record, so there's nothing to push.
  }

  getAvailableRecoveryActions(): ActionType[] {
    return [
      "WAIT",
      "VERIFY_PAYMENT",
      "SEND_REMINDER",
      "GENERATE_PAYMENT_LINK",
      "OFFER_ALTERNATIVE_PAYMENT_METHOD",
      "SCHEDULE_FOLLOW_UP",
      "RECORD_PROMISE_TO_PAY",
      "RECOMMEND_VOICE_OUTREACH",
      "ESCALATE_TO_HUMAN",
      "STOP_RECOVERY",
    ];
  }

  private toContext(obligation: {
    id: string;
    referenceType: string;
    referenceId: string;
    customerId: string | null;
    outstandingAmountPaise: number;
    status: string;
  }): ObligationContext {
    return {
      obligationId: obligation.id,
      referenceType: obligation.referenceType,
      referenceId: obligation.referenceId,
      customerId: obligation.customerId ?? undefined,
      amountPaise: obligation.outstandingAmountPaise,
      status: obligation.status as ObligationContext["status"],
    };
  }
}

export const merchantAdapter = new GenericEcommerceAdapter();
