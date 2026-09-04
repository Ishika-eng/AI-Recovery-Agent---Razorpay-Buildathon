import { NextRequest, NextResponse } from "next/server";
import { deleteSession } from "@/lib/session";

// An orphaned session — a signed, unexpired cookie whose merchantId no
// longer exists (e.g. dev.db got reset/recreated after the cookie was
// issued) — used to be a dead end: the proxy sees a valid signature and
// treats the visitor as logged in, while the protected page sees no
// merchant and sends them to /login, which the proxy immediately bounces
// straight back to /dashboard. Neither side can break that loop on its
// own — the proxy only checks the signature (it never touches the DB,
// deliberately, since it must stay fast/stateless), and a Server
// Component's render can't mutate cookies. A Route Handler can, so this
// is the one place that actually clears the stale cookie before sending
// the visitor to /login for real.
export async function GET(req: NextRequest) {
  await deleteSession();
  return NextResponse.redirect(new URL("/login", req.url));
}
