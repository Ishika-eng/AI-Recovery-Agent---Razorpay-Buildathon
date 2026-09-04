import { NextRequest, NextResponse } from "next/server";
import { processDueCases } from "@/lib/engine";

// The autonomy hook. Next.js route handlers only run in response to a
// request — nothing in this codebase runs on a timer by itself. This route
// is what makes WAIT / SCHEDULE_FOLLOW_UP cases actually advance on their
// own: something has to call it on a schedule. In production that's a
// platform cron (Vercel Cron — see vercel.json — automatically sends
// `Authorization: Bearer $CRON_SECRET` when that env var is set) or any
// external scheduler hitting this URL. Locally, `npm run scheduler` polls it
// every few seconds so the demo shows real autonomous behavior, not just
// reactions to webhooks and dashboard clicks.
function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured — allowed in dev, must be set for any real deployment
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await processDueCases();
  return NextResponse.json(result);
}

// Some free/simple cron pingers only issue GET requests — support both
// rather than forcing every scheduler option to support a POST body.
export async function GET(req: NextRequest) {
  return POST(req);
}
