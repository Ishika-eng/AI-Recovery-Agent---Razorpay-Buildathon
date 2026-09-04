import crypto from "crypto";

// Signs an obligation id so the public, no-login unsubscribe link
// (src/app/api/optout/route.ts) in every reminder email can't be used to
// opt out an obligation the link wasn't actually issued for — anyone who
// can guess a cuid shouldn't be able to silence someone else's recovery
// case. Not a JWT: this token has no expiry by design, matching how real
// unsubscribe links work (they stay valid indefinitely), and encodes
// nothing but "this specific obligation," so there's nothing sensitive to
// leak if the link is forwarded.
function secret() {
  return process.env.SESSION_SECRET ?? "dev-only-fallback-secret";
}

export function createOptOutToken(obligationId: string): string {
  return crypto.createHmac("sha256", secret()).update(obligationId).digest("hex");
}

export function verifyOptOutToken(obligationId: string, token: string): boolean {
  const expected = createOptOutToken(obligationId);
  return expected.length === token.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
