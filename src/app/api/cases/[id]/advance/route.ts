import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { advanceCase } from "@/lib/engine";

// Manual "tick" for a WAITING case — stands in for a real scheduler/cron so
// the state machine (PRD §21) can be demonstrated interactively: WAIT
// elapsing, a follow-up coming due, a promise-to-pay date arriving.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const owned = await db.recoveryCase.findFirst({ where: { id, obligation: { merchantId: merchant.id } } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await advanceCase(id);
  return NextResponse.json(result);
}
