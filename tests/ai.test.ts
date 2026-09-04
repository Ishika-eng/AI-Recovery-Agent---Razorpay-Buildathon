import { describe, expect, it } from "vitest";
import { decideRecoveryAction } from "@/lib/ai";
import type { RecoveryCaseContext } from "@/lib/types";

const ALL_ACTIONS: RecoveryCaseContext["allowedActions"] = [
  "WAIT",
  "VERIFY_PAYMENT",
  "SEND_REMINDER",
  "GENERATE_PAYMENT_LINK",
  "OFFER_ALTERNATIVE_PAYMENT_METHOD",
  "SCHEDULE_FOLLOW_UP",
  "RECORD_PROMISE_TO_PAY",
  "ESCALATE_TO_HUMAN",
  "STOP_RECOVERY",
];

function context(overrides: {
  customerValue: "LOW" | "STANDARD" | "HIGH";
  relationshipAgeDays?: number;
  successfulPayments?: number;
  messagesSent?: number;
  waitedAlready?: boolean;
  failureCategory?: RecoveryCaseContext["paymentHistory"][number]["failureCategory"];
  referenceType?: string;
  providerHealth?: RecoveryCaseContext["providerHealth"];
}): RecoveryCaseContext {
  return {
    obligation: {
      id: "obl_1",
      referenceType: overrides.referenceType ?? "ORDER",
      amountPaise: 500000,
      outstandingAmountPaise: 500000,
      status: "UNPAID",
    },
    customer: {
      relationshipAgeDays: overrides.relationshipAgeDays ?? 0,
      successfulPayments: overrides.successfulPayments ?? 0,
      customerValue: overrides.customerValue,
    },
    paymentHistory: [{ provider: "razorpay", status: "FAILED", failureCategory: overrides.failureCategory ?? "TIMEOUT" }],
    recoveryHistory: {
      messagesSent: overrides.messagesSent ?? 0,
      retryCount: 1,
      waitedAlready: overrides.waitedAlready ?? false,
      lastActionAt: null,
    },
    providerHealth: overrides.providerHealth ?? { suspectedOutage: false, affectedObligations: 0, windowMinutes: 15 },
    allowedActions: ALL_ACTIONS,
  };
}

// This is the ₹50,000-loyal-customer vs ₹500-new-customer example from the
// problem statement, made concrete: two cases identical in every way except
// who the customer is must produce different decisions, not just different
// reasoning text describing the same decision.
describe("decideRecoveryAction — calibrated to customer value", () => {
  it("waits longer before nudging a high-value, long-tenured customer than a new one", () => {
    const highValue = decideRecoveryAction(
      context({ customerValue: "HIGH", relationshipAgeDays: 500, successfulPayments: 20 })
    );
    const lowValue = decideRecoveryAction(
      context({ customerValue: "LOW", relationshipAgeDays: 0, successfulPayments: 0 })
    );

    expect(highValue.action).toBe("WAIT");
    expect(lowValue.action).toBe("WAIT");
    expect(highValue.waitMinutes).toBeGreaterThan(lowValue.waitMinutes!);
  });

  it("escalates a high-value customer to a human sooner than a low-value one", () => {
    // One automated message already sent, still unpaid, next decision:
    const highValue = decideRecoveryAction(context({ customerValue: "HIGH", messagesSent: 1 }));
    const standard = decideRecoveryAction(context({ customerValue: "STANDARD", messagesSent: 1 }));
    const lowValue = decideRecoveryAction(context({ customerValue: "LOW", messagesSent: 1 }));

    expect(highValue.action).toBe("ESCALATE_TO_HUMAN"); // this tier's limit is 1 automated attempt
    expect(standard.action).toBe("SCHEDULE_FOLLOW_UP"); // standard tolerates a second attempt first
    expect(lowValue.action).toBe("SCHEDULE_FOLLOW_UP"); // low tolerates a third attempt first

    // And at messagesSent = 2, standard has now hit its limit but low hasn't yet.
    const standardAtTwo = decideRecoveryAction(context({ customerValue: "STANDARD", messagesSent: 2 }));
    const lowAtTwo = decideRecoveryAction(context({ customerValue: "LOW", messagesSent: 2 }));
    expect(standardAtTwo.action).toBe("ESCALATE_TO_HUMAN");
    expect(lowAtTwo.action).toBe("SCHEDULE_FOLLOW_UP");
  });

  it("still ignores customer value when the failure is a hard decline — no point waiting regardless of who it is", () => {
    const highValue = decideRecoveryAction(context({ customerValue: "HIGH", failureCategory: "ISSUER_DECLINE" }));
    const lowValue = decideRecoveryAction(context({ customerValue: "LOW", failureCategory: "ISSUER_DECLINE" }));

    expect(highValue.action).toBe("GENERATE_PAYMENT_LINK");
    expect(lowValue.action).toBe("GENERATE_PAYMENT_LINK");
  });

  it("names the customer tier and relationship in its reasoning, for auditability", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "HIGH", relationshipAgeDays: 365, successfulPayments: 12 })
    );
    expect(decision.reason).toMatch(/high-value/i);
    expect(decision.reason).toMatch(/365-day/);
  });
});

describe("decideRecoveryAction — payment-method lifecycle (PRD Problem 28)", () => {
  it("offers a genuinely different payment method on an expired card, not a plain retry link", () => {
    const decision = decideRecoveryAction(context({ customerValue: "STANDARD", failureCategory: "EXPIRED_CARD" }));
    expect(decision.action).toBe("OFFER_ALTERNATIVE_PAYMENT_METHOD");
    expect(decision.reason).toMatch(/expired/i);
  });

  it("ignores customer value for an expired card — the instrument is dead regardless of who owns it", () => {
    const highValue = decideRecoveryAction(context({ customerValue: "HIGH", failureCategory: "EXPIRED_CARD" }));
    const lowValue = decideRecoveryAction(context({ customerValue: "LOW", failureCategory: "EXPIRED_CARD" }));
    expect(highValue.action).toBe("OFFER_ALTERNATIVE_PAYMENT_METHOD");
    expect(lowValue.action).toBe("OFFER_ALTERNATIVE_PAYMENT_METHOD");
  });

  it("escalates a SUBSCRIPTION with an expired card to a human after just one automated attempt", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "LOW", failureCategory: "EXPIRED_CARD", referenceType: "SUBSCRIPTION", messagesSent: 1 })
    );
    expect(decision.action).toBe("ESCALATE_TO_HUMAN");
    expect(decision.reason).toMatch(/renewal/i);
  });

  it("still tries OFFER_ALTERNATIVE_PAYMENT_METHOD once on a SUBSCRIPTION before escalating", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "LOW", failureCategory: "EXPIRED_CARD", referenceType: "SUBSCRIPTION", messagesSent: 0 })
    );
    expect(decision.action).toBe("OFFER_ALTERNATIVE_PAYMENT_METHOD");
  });

  it("does not escalate a one-off ORDER with an expired card early just because a message was already sent", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "LOW", failureCategory: "EXPIRED_CARD", referenceType: "ORDER", messagesSent: 1 })
    );
    expect(decision.action).not.toBe("ESCALATE_TO_HUMAN");
  });
});

describe("decideRecoveryAction — provider-outage detection (PRD Problem 11)", () => {
  const outageHealth: RecoveryCaseContext["providerHealth"] = {
    suspectedOutage: true,
    affectedObligations: 5,
    windowMinutes: 15,
  };

  it("waits longer than usual instead of contacting the customer when an outage is suspected", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "STANDARD", failureCategory: "TIMEOUT", providerHealth: outageHealth })
    );
    expect(decision.action).toBe("WAIT");
    expect(decision.waitMinutes).toBe(20); // double the STANDARD tier's usual 10 minutes
    expect(decision.reason).toMatch(/outage/i);
  });

  it("escalates to a human instead of waiting indefinitely or contacting the customer once already waited through a suspected outage", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "STANDARD", failureCategory: "TIMEOUT", providerHealth: outageHealth, waitedAlready: true })
    );
    expect(decision.action).toBe("ESCALATE_TO_HUMAN");
    expect(decision.reason).toMatch(/outage/i);
  });

  it("does not treat an isolated transient failure as an outage — normal wait behavior applies", () => {
    const decision = decideRecoveryAction(context({ customerValue: "STANDARD", failureCategory: "TIMEOUT" }));
    expect(decision.action).toBe("WAIT");
    expect(decision.waitMinutes).toBe(10); // the normal STANDARD-tier window, not doubled
  });

  it("still treats a hard decline as a genuine instrument problem even during a suspected outage", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "STANDARD", failureCategory: "ISSUER_DECLINE", providerHealth: outageHealth })
    );
    expect(decision.action).toBe("GENERATE_PAYMENT_LINK");
  });

  it("still treats an expired card as a genuine instrument problem even during a suspected outage", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "STANDARD", failureCategory: "EXPIRED_CARD", providerHealth: outageHealth })
    );
    expect(decision.action).toBe("OFFER_ALTERNATIVE_PAYMENT_METHOD");
  });
});

describe("decideRecoveryAction — checkout drop-off recovery (cart abandonment)", () => {
  it("sends a direct payment link immediately on a dropped-off checkout, skipping the wait window", () => {
    const decision = decideRecoveryAction(context({ customerValue: "STANDARD", failureCategory: "USER_DROPOFF" }));
    expect(decision.action).toBe("GENERATE_PAYMENT_LINK");
    expect(decision.reason).toMatch(/abandoned/i);
  });

  it("ignores customer value for the first touch — abandonment intent decays regardless of tier", () => {
    const highValue = decideRecoveryAction(context({ customerValue: "HIGH", failureCategory: "USER_DROPOFF" }));
    const lowValue = decideRecoveryAction(context({ customerValue: "LOW", failureCategory: "USER_DROPOFF" }));
    expect(highValue.action).toBe("GENERATE_PAYMENT_LINK");
    expect(lowValue.action).toBe("GENERATE_PAYMENT_LINK");
  });

  it("does not re-trigger the drop-off link once a first touch has already gone out", () => {
    const decision = decideRecoveryAction(
      context({ customerValue: "STANDARD", failureCategory: "USER_DROPOFF", messagesSent: 1 })
    );
    expect(decision.action).not.toBe("GENERATE_PAYMENT_LINK");
  });
});
