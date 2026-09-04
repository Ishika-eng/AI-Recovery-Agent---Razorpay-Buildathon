import { describe, expect, it } from "vitest";
import { decideNaiveBaseline } from "@/lib/baseline";
import type { RecoveryCaseContext } from "@/lib/types";

function context(overrides: { status?: RecoveryCaseContext["obligation"]["status"]; messagesSent?: number }): RecoveryCaseContext {
  return {
    obligation: {
      id: "obl_1",
      referenceType: "ORDER",
      amountPaise: 100000,
      outstandingAmountPaise: 100000,
      status: overrides.status ?? "UNPAID",
    },
    customer: { relationshipAgeDays: 0, successfulPayments: 0, customerValue: "STANDARD" },
    paymentHistory: [{ provider: "razorpay", status: "FAILED", failureCategory: "TIMEOUT" }],
    recoveryHistory: {
      messagesSent: overrides.messagesSent ?? 0,
      retryCount: 1,
      waitedAlready: false,
      lastActionAt: null,
    },
    providerHealth: { suspectedOutage: false, affectedObligations: 0, windowMinutes: 15 },
    allowedActions: ["WAIT", "VERIFY_PAYMENT", "SEND_REMINDER", "GENERATE_PAYMENT_LINK", "OFFER_ALTERNATIVE_PAYMENT_METHOD", "SCHEDULE_FOLLOW_UP", "RECORD_PROMISE_TO_PAY", "ESCALATE_TO_HUMAN", "STOP_RECOVERY"],
  };
}

describe("decideNaiveBaseline — the fixed-schedule rule the AI is measured against", () => {
  it("stops recovery once already paid, same as the real AI would", () => {
    const decision = decideNaiveBaseline(context({ status: "PAID" }));
    expect(decision.action).toBe("STOP_RECOVERY");
  });

  it("always sends a reminder on the first touch, regardless of failure category or customer value", () => {
    const decision = decideNaiveBaseline(context({ messagesSent: 0 }));
    expect(decision.action).toBe("SEND_REMINDER");
  });

  it("always generates a payment link on the second touch", () => {
    const decision = decideNaiveBaseline(context({ messagesSent: 1 }));
    expect(decision.action).toBe("GENERATE_PAYMENT_LINK");
  });

  it("gives up after two automated touches", () => {
    const decision = decideNaiveBaseline(context({ messagesSent: 2 }));
    expect(decision.action).toBe("ESCALATE_TO_HUMAN");
  });
});
