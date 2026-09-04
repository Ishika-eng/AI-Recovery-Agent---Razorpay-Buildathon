"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Controls for an open/waiting recovery case: "Advance" forces this one case
// forward right now instead of waiting for the scheduler (see
// /api/cron/tick — that's what actually fires WAIT/follow-up timers on
// their own in the background). "Simulate paid elsewhere" stands in for the
// customer completing payment through a channel this platform has no
// dedicated webhook for. "Mark opted out" is the merchant-side trigger for
// a customer who said "don't contact me" over a channel (a phone call) this
// platform has no inbound webhook for — the real, email-link-driven trigger
// is src/app/api/optout/route.ts. "Write off" is the terminal decision a
// case previously had no way to reach — a case escalated once, or a dozen
// times, but nothing ever actually closed it; this is the human deciding
// to stop, not the AI proposing a pause. "Record promise to pay" is the
// merchant-side trigger for RECORD_PROMISE_TO_PAY — a promise made on a
// call is something only a human can hear, so the AI never proposes this
// itself; see recordPromiseToPay in src/lib/engine.ts.
export function CaseControls({ caseId, obligationId }: { caseId: string; obligationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"advance" | "external" | "optout" | "writeoff" | "promise" | null>(null);

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

  async function markOptedOut() {
    setPending("optout");
    try {
      await fetch(`/api/cases/${caseId}/opt-out`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function writeOff() {
    if (!confirm("Write off this obligation? This stops all recovery permanently — it can't be undone from here.")) return;
    setPending("writeoff");
    try {
      await fetch(`/api/cases/${caseId}/write-off`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function recordPromise() {
    setPending("promise");
    try {
      await fetch(`/api/cases/${caseId}/promise-to-pay`, { method: "POST" });
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
        title="Force this case forward now, instead of waiting for the scheduler"
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
      <button
        onClick={markOptedOut}
        disabled={pending !== null}
        className="rounded border border-amber-300 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
        title="Customer asked not to be contacted (e.g. on a call) — stop all automated communication"
      >
        {pending === "optout" ? "Updating…" : "Mark opted out"}
      </button>
      <button
        onClick={writeOff}
        disabled={pending !== null}
        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
        title="Stop pursuing this obligation permanently — a human decision, not an AI-proposed pause"
      >
        {pending === "writeoff" ? "Writing off…" : "Write off"}
      </button>
      <button
        onClick={recordPromise}
        disabled={pending !== null}
        className="rounded border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
        title="Customer promised to pay on a call — parks the case for 24h and re-verifies automatically"
      >
        {pending === "promise" ? "Recording…" : "Record promise to pay"}
      </button>
    </div>
  );
}
