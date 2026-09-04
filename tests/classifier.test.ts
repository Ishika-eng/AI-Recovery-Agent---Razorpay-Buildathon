import { describe, expect, it } from "vitest";
import { classifyFailure } from "@/lib/classifier";

describe("classifyFailure", () => {
  it("classifies a missing payment attempt as checkout drop-off", () => {
    const result = classifyFailure({ hadPaymentAttempt: false });
    expect(result.failureCategory).toBe("USER_DROPOFF");
  });

  it("classifies timeout errors from the error code", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "GATEWAY_TIMEOUT" });
    expect(result.failureCategory).toBe("TIMEOUT");
  });

  it("classifies timeout errors from the description when the code doesn't say it", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "SOME_CODE", errorDescription: "Request timed out" });
    expect(result.failureCategory).toBe("TIMEOUT");
  });

  it("classifies insufficient funds", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorDescription: "Insufficient balance in account" });
    expect(result.failureCategory).toBe("INSUFFICIENT_FUNDS");
  });

  it("classifies gateway errors", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "BAD_REQUEST_ERROR", errorDescription: "Gateway processing error" });
    expect(result.failureCategory).toBe("GATEWAY_ERROR");
  });

  it("classifies network errors", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorDescription: "Network error while connecting to issuer" });
    expect(result.failureCategory).toBe("NETWORK_ERROR");
  });

  it("classifies issuer declines", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "CARD_DECLINED", errorDescription: "Card was declined" });
    expect(result.failureCategory).toBe("ISSUER_DECLINE");
  });

  it("classifies an expired card from the error code", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "EXPIRED_CARD" });
    expect(result.failureCategory).toBe("EXPIRED_CARD");
  });

  it("classifies an expired card from the description, taking priority over a generic decline", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "CARD_DECLINED", errorDescription: "The card has expired" });
    expect(result.failureCategory).toBe("EXPIRED_CARD");
  });

  it("classifies an expired card over a gateway/BAD_REQUEST_ERROR code", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "BAD_REQUEST_ERROR", errorDescription: "Your card has expired" });
    expect(result.failureCategory).toBe("EXPIRED_CARD");
  });

  it("classifies 'do not honour' as an issuer decline", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorDescription: "Do not honour" });
    expect(result.failureCategory).toBe("ISSUER_DECLINE");
  });

  it("falls back to UNKNOWN for unrecognized errors", () => {
    const result = classifyFailure({ hadPaymentAttempt: true, errorCode: "WEIRD_CODE", errorDescription: "Something odd happened" });
    expect(result.failureCategory).toBe("UNKNOWN");
  });

  it("prioritizes drop-off detection over error-code matching when there was no payment attempt", () => {
    const result = classifyFailure({ hadPaymentAttempt: false, errorCode: "CARD_DECLINED" });
    expect(result.failureCategory).toBe("USER_DROPOFF");
  });
});
