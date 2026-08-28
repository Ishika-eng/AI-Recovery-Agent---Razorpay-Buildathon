import type { ObligationContext, ActionType } from "@/lib/types";

// MerchantAdapter — the other half of the integration surface (PRD §9-10).
// Whatever the merchant calls their business record internally (order,
// invoice, subscription, enrollment, booking...) becomes, on this side of
// the adapter, one thing: a PAYMENT OBLIGATION. The recovery engine never
// asks "what table is this in" — only "what is associated with reference X".
export interface MerchantAdapter {
  getObligation(referenceType: string, referenceId: string): Promise<ObligationContext | null>;
  getObligationStatus(obligationId: string): Promise<ObligationContext["status"]>;
  getCustomerContext(customerId: string): Promise<{
    relationshipAgeDays: number;
    successfulPayments: number;
    customerValue: "LOW" | "STANDARD" | "HIGH";
  }>;
  notifyStatusChange(obligationId: string, status: ObligationContext["status"]): Promise<void>;
  getAvailableRecoveryActions(): ActionType[];
}
