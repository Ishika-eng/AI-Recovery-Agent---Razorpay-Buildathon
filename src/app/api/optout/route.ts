import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyOptOutToken } from "@/lib/optout";
import { optOutCustomer } from "@/lib/engine";

function page(body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Contact preferences</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#14161c;">${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// The real, no-login trigger for the customer-opt-out guardrail — the link
// every reminder email actually contains (src/lib/actions/email.ts). A
// customer clicking this is "don't contact me" in the exact form PRD
// Problem 11 describes, not a simulated one.
export async function GET(req: NextRequest) {
  const obligationId = req.nextUrl.searchParams.get("obligation");
  const token = req.nextUrl.searchParams.get("token");

  if (!obligationId || !token || !verifyOptOutToken(obligationId, token)) {
    return page("<h1>Invalid link</h1><p>This unsubscribe link is invalid or has been tampered with.</p>", 400);
  }

  const obligation = await db.paymentObligation.findUnique({ where: { id: obligationId } });
  if (!obligation) {
    return page("<h1>Not found</h1><p>We couldn't find what this link refers to.</p>", 404);
  }

  await optOutCustomer(obligationId, "customer clicked the unsubscribe link");

  return page("<h1>You're opted out</h1><p>We won't contact you about this again. If this was a mistake, please contact the merchant directly.</p>");
}
