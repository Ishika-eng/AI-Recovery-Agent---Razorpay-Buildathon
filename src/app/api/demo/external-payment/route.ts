import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { resolveExternalPayment } from "@/lib/engine";

const Body = z.object({ obligationId: z.string() });

// Demo-only convenience wrapper around resolveExternalPayment, driven by a
// dashboard button rather than a real external system — this is what
// produces the "Recovery Action Prevented" moment from PRD §28 Scenario 2
// on demand, without needing a second live payment provider in the room.
export async function POST(req: NextRequest) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { obligationId } = Body.parse(await req.json());
  const owned = await db.paymentObligation.findFirst({ where: { id: obligationId, merchantId: merchant.id } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const resolved = await resolveExternalPayment(obligationId, `demo_ext_${Date.now()}`);
  return NextResponse.json({ status: "resolved", obligationId: resolved.id });
}
