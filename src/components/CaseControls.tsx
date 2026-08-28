"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Demo controls for an open/waiting recovery case: manually "advance" the
// state machine (stands in for the scheduler that would fire WAIT/follow-up
// timers in production), or simulate the customer paying through a channel
// this platform has no dedicated webhook for — the interaction that
// triggers cross-channel resolution (PRD §13/§14) live.
export function CaseControls({ caseId, obligationId }: { caseId: string; obligationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"advance" | "external" | null>(null);

  async function advance() {
    setPending("advance");
    try {
      await fetch(`/api/cases/${caseId}/advance`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function payElsewhere() {
    setPending("external");
    try {
      await fetch("/api/demo/external-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ obligationId }),
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={advance}
        disabled={pending !== null}
        className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        title="Advance the recovery state machine (simulates the scheduled check firing)"
      >
        {pending === "advance" ? "Advancing…" : "Advance"}
      </button>
      <button
        onClick={payElsewhere}
        disabled={pending !== null}
        className="rounded border border-indigo-300 bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
        title="Simulate the customer completing payment through another channel"
      >
        {pending === "external" ? "Paying…" : "Simulate paid elsewhere"}
      </button>
    </div>
  );
}
