import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { advanceCase } from "@/lib/engine";

// Manual, immediate tick for one case — the human override. The autonomous
// path is /api/cron/tick (src/lib/engine.ts processDueCases), which advances
// every merchant's due cases on a schedule without anyone clicking anything;
// this route exists so a merchant (or a demo) can force a specific case
// forward right now instead of waiting for its nextActionAt.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const owned = await db.recoveryCase.findFirst({ where: { id, obligation: { merchantId: merchant.id } } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await advanceCase(id);
  return NextResponse.json(result);
}
