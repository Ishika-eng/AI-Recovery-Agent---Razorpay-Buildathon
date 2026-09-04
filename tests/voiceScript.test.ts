import { describe, expect, it } from "vitest";
import { generateHinglishVoiceScript } from "@/lib/voiceScript";
import type { RecoveryCaseContext } from "@/lib/types";

function context(overrides: { outstandingAmountPaise?: number; referenceType?: string }): RecoveryCaseContext {
  return {
    obligation: {
      id: "obl_1",
      referenceType: overrides.referenceType ?? "ORDER",
      amountPaise: 500000,
      outstandingAmountPaise: overrides.outstandingAmountPaise ?? 500000,
      status: "UNPAID",
    },
    customer: { relationshipAgeDays: 400, successfulPayments: 12, customerValue: "HIGH" },
    paymentHistory: [{ provider: "razorpay", status: "FAILED", failureCategory: "TIMEOUT" }],
    recoveryHistory: { messagesSent: 1, retryCount: 1, waitedAlready: false, lastActionAt: null, brokenPromiseCount: 0 },
    providerHealth: { suspectedOutage: false, affectedObligations: 0, windowMinutes: 15 },
    allowedActions: ["RECOMMEND_VOICE_OUTREACH"],
  };
}

describe("generateHinglishVoiceScript — an honest, usable deliverable, not a fake phone call", () => {
  it("includes the outstanding amount in the script", () => {
    const script = generateHinglishVoiceScript(context({ outstandingAmountPaise: 750000 }));
    expect(script).toContain("₹7500.00");
  });

  it("is written in a natural Hinglish register, not plain English or transliterated formality", () => {
    const script = generateHinglishVoiceScript(context({}));
    expect(script).toMatch(/Namaste/);
    expect(script).toMatch(/Dhanyavaad/);
  });

  it("offers a concrete next step (a fresh payment link) rather than just asking for money", () => {
    const script = generateHinglishVoiceScript(context({}));
    expect(script).toMatch(/payment link/i);
  });
});
