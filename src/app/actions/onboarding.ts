"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifySession } from "@/lib/dal";

// The gate between signup and the dashboard (PRD-adjacent product
// requirement, not the payments PRD): a merchant must explicitly accept
// what the recovery agent is authorized to do — auto-retry limits, contact
// windows, approval thresholds — before it can act on their behalf.
export async function acceptTermsAction() {
  const session = await verifySession();
  if (!session) redirect("/login");

  await db.merchant.update({
    where: { id: session.merchantId },
    data: { termsAcceptedAt: new Date() },
  });

  redirect("/dashboard");
}
