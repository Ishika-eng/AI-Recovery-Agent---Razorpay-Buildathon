import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { decrypt, readSessionCookie } from "@/lib/session";

// Data Access Layer, per Next.js's authentication guide — every data
// request that needs to know "who is logged in" goes through here, not
// through ad-hoc cookie reads scattered across routes/pages. Wrapped in
// React's cache() so a render pass that calls this multiple times only
// verifies the session once.
export const verifySession = cache(async (): Promise<{ merchantId: string } | null> => {
  const token = await readSessionCookie();
  const session = await decrypt(token);
  return session ? { merchantId: session.merchantId } : null;
});

// Returns the full merchant record for the current session, or null if
// there is no session / the merchant no longer exists. This is the one
// place route handlers and pages should call to find "which merchant am I
// acting as" — replaces the single-tenant db.merchant.findFirst() calls
// from before auth existed.
export const getCurrentMerchant = cache(async () => {
  const session = await verifySession();
  if (!session) return null;
  return db.merchant.findUnique({ where: { id: session.merchantId } });
});
