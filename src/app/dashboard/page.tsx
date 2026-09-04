import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { SeedButton } from "@/components/SeedButton";
import { ApprovalActions } from "@/components/ApprovalActions";
import { CaseControls } from "@/components/CaseControls";
import { LogoutButton } from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

function formatPaise(paise: number) {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function isWithinLastMs(date: Date, windowMs: number) {
  return Date.now() - date.getTime() < windowMs;
}

const FAILURE_LABELS: Record<string, string> = {
  ISSUER_DECLINE: "Issuer decline",
  EXPIRED_CARD: "Expired card",
  TIMEOUT: "Timeout",
  INSUFFICIENT_FUNDS: "Insufficient funds",
  GATEWAY_ERROR: "Gateway error",
  NETWORK_ERROR: "Network error",
  USER_DROPOFF: "Checkout drop-off",
  RECEIVABLE_OVERDUE: "Overdue invoice",
  UNKNOWN: "Unclassified",
};

const ACTION_LABELS: Record<string, string> = {
  WAIT: "Wait & re-verify",
  VERIFY_PAYMENT: "Verify payment status",
  SEND_REMINDER: "Send reminder",
  GENERATE_PAYMENT_LINK: "Generate payment link",
  OFFER_ALTERNATIVE_PAYMENT_METHOD: "Offer alternative method",
  SCHEDULE_FOLLOW_UP: "Schedule follow-up",
  RECORD_PROMISE_TO_PAY: "Record promise-to-pay",
  RECOMMEND_VOICE_OUTREACH: "Recommend voice outreach",
  ESCALATE_TO_HUMAN: "Escalate to human",
  STOP_RECOVERY: "Stop recovery",
};

const PROVIDER_LABELS: Record<string, string> = {
  razorpay: "Razorpay",
  stripe: "Stripe",
  external: "External / other channel",
};

export default async function DashboardPage() {
  // Defense in depth: proxy.ts already redirects unauthenticated requests
  // to /login optimistically, but the merchant-specific checks (session
  // validity, terms acceptance) belong here, close to the data. A missing
  // merchant here despite a signed session cookie means the cookie is
  // orphaned (e.g. it outlived a dev.db reset) — redirecting straight to
  // /login would loop forever, since the proxy sees a still-valid
  // signature and immediately bounces /login back to /dashboard. Routing
  // through a handler that can actually clear the cookie breaks that loop.
  const merchant = await getCurrentMerchant();
  if (!merchant) redirect("/api/auth/clear-session");
  if (!merchant.termsAcceptedAt) redirect("/onboarding");

  const [obligations, pendingActions, recentAudit, recoveryActionsPrevented, allAttempts, openCases, resolvedObligations, attributedSum, aiVsBaselineActions, promiseActions] =
    await Promise.all([
      db.paymentObligation.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: "desc" } }),
      db.recoveryAction.findMany({
        where: { executionStatus: "PENDING_APPROVAL", case: { obligation: { merchantId: merchant.id } } },
        include: { case: { include: { obligation: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.auditLog.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: "desc" }, take: 25 }),
      db.auditLog.count({ where: { merchantId: merchant.id, action: "RECOVERY_ACTION_PREVENTED" } }),
      db.paymentAttempt.findMany({ where: { obligation: { merchantId: merchant.id } } }),
      db.recoveryCase.findMany({
        where: { obligation: { merchantId: merchant.id }, status: { in: ["OPEN", "WAITING", "ESCALATED"] } },
        include: { obligation: { include: { attempts: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.paymentObligation.findMany({
        where: { merchantId: merchant.id, status: { in: ["PAID", "CANCELLED", "REFUNDED"] } },
        orderBy: { resolvedAt: "desc" },
        take: 10,
      }),
      // Attribution (PRD Problem 7): the sum of recoveredPaise across
      // actions is only ever set when a resolution was actually traced back
      // to that specific action (a matched payment link, or the simulated
      // demo path) — never inferred from "a case existed at the time." This
      // is deliberately a smaller, more honest number than "₹ recovered."
      db.recoveryAction.aggregate({
        _sum: { recoveredPaise: true },
        where: { recoveredPaise: { not: null }, case: { obligation: { merchantId: merchant.id, status: "PAID" } } },
      }),
      // AI-vs-rules defensibility (PRD Problem 37): every AI proposal also
      // carries what a naive, fixed-schedule dunning rule would have done
      // instead (never executed — see decideNaiveBaseline in
      // src/lib/baseline.ts) so the value of the calibrated AI layer can be
      // shown concretely rather than just asserted.
      db.recoveryAction.findMany({
        where: { proposedBy: "AI", baselineAction: { not: null }, case: { obligation: { merchantId: merchant.id } } },
        select: { actionType: true, baselineAction: true },
      }),
      // Promise-to-pay tracker: every RECORD_PROMISE_TO_PAY action that
      // actually executed, with just enough of its obligation to bucket
      // it into kept / broken / still pending below.
      db.recoveryAction.findMany({
        where: { actionType: "RECORD_PROMISE_TO_PAY", executionStatus: "EXECUTED", case: { obligation: { merchantId: merchant.id } } },
        select: { executedAt: true, case: { select: { obligation: { select: { status: true, resolvedAt: true } } } } },
        orderBy: { executedAt: "desc" },
      }),
    ]);

  const totalObligations = obligations.length;
  const paidObligations = obligations.filter((o) => o.status === "PAID");
  // Net of refunds (PRD Problem 26) — a fully refunded obligation already
  // carries status REFUNDED and falls out of paidObligations entirely; a
  // partial refund stays PAID but its refunded amount is subtracted here so
  // this number never overstates revenue that was actually given back.
  const recoveredPaise = paidObligations.reduce((sum, o) => sum + (o.originalAmountPaise - o.refundedAmountPaise), 0);
  const attributedPaise = attributedSum._sum.recoveredPaise ?? 0;
  const atRiskPaise = obligations
    .filter((o) => o.status === "UNPAID" || o.status === "PARTIALLY_PAID" || o.status === "PENDING")
    .reduce((sum, o) => sum + o.outstandingAmountPaise, 0);
  const recoveryRate = totalObligations > 0 ? (paidObligations.length / totalObligations) * 100 : 0;

  // The headline differentiator metric (PRD §29): obligations resolved
  // through a channel other than the one that originally failed — proof
  // the platform reconciled across providers instead of blindly recovering
  // a dead transaction.
  const crossChannelResolutions = paidObligations.filter((o) => {
    const attemptProviders = new Set(allAttempts.filter((a) => a.obligationId === o.id).map((a) => a.provider));
    return (o.resolutionSource && attemptProviders.size > 1) || o.resolutionSource === "external";
  });
  // PRD Problem 11: surface a suspected provider outage as a merchant-
  // visible alert, not just something buried in the audit trail — the
  // whole point of detecting it is that a human should know their
  // provider might be down, not just that automated messaging paused.
  const OUTAGE_ALERT_WINDOW_MS = 15 * 60 * 1000;
  const suspectedOutageAudit = recentAudit.find(
    (log) => /suspected provider outage/i.test(log.reasoning) && isWithinLastMs(log.createdAt, OUTAGE_ALERT_WINDOW_MS)
  );

  // AI-vs-rules defensibility (PRD Problem 37): how often, and to what,
  // did the calibrated AI decide differently than the naive fixed-schedule
  // baseline would have? A 0% divergence rate would be an honest signal
  // that the calibration layer isn't actually earning its complexity.
  const aiVsBaselineTotal = aiVsBaselineActions.length;
  const divergentActions = aiVsBaselineActions.filter((a) => a.actionType !== a.baselineAction);
  const divergenceRate = aiVsBaselineTotal > 0 ? (divergentActions.length / aiVsBaselineTotal) * 100 : 0;
  const divergenceBreakdown = Object.entries(
    divergentActions.reduce<Record<string, number>>((acc, a) => {
      const key = `${a.baselineAction} → ${a.actionType}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);

  // Promise-to-pay tracker: kept if the obligation was paid at or after
  // the promise was recorded; broken if the 24h window has passed with it
  // still unresolved; otherwise still within the window.
  const PROMISE_WINDOW_MS = 24 * 3_600_000;
  const promiseOutcomes = promiseActions.map((a) => {
    const obligation = a.case.obligation;
    const kept = obligation.status === "PAID" && obligation.resolvedAt !== null && a.executedAt !== null && obligation.resolvedAt >= a.executedAt;
    const stillPending = !kept && a.executedAt !== null && isWithinLastMs(a.executedAt, PROMISE_WINDOW_MS);
    const broken = !kept && !stillPending;
    return kept ? "kept" : broken ? "broken" : "pending";
  });
  const promisesKept = promiseOutcomes.filter((o) => o === "kept").length;
  const promisesBroken = promiseOutcomes.filter((o) => o === "broken").length;
  const promisesPending = promiseOutcomes.filter((o) => o === "pending").length;

  const byFailureType = Object.entries(
    allAttempts
      .filter((a) => a.status === "FAILED")
      .reduce<Record<string, number>>((acc, a) => {
        const key = a.failureCategory ?? "UNKNOWN";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
  ).sort((a, b) => b[1] - a[1]);

  return (
    <div className="min-h-screen bg-neutral-50 pb-24 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <h1 className="text-lg font-semibold">Universal Payment Recovery & Reconciliation</h1>
            <p className="text-sm text-neutral-500">{merchant.name} · {merchant.email} · test mode</p>
          </div>
          <div className="flex items-center gap-3">
            <SeedButton />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 space-y-10">
        {suspectedOutageAudit && (
          <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">Possible provider outage detected.</span>{" "}
            {suspectedOutageAudit.reasoning} Automated customer contact is paused for affected cases until this
            clears.
          </div>
        )}
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="₹ recovered" value={formatPaise(recoveredPaise)} accent="text-emerald-600" hint="Net of refunds — obligations currently PAID, minus any amount refunded back" />
          <StatTile
            label="Attributed to AI action"
            value={formatPaise(attributedPaise)}
            accent="text-emerald-700"
            hint="Only counted when traced to a specific action this platform took (a matched payment link) — not inferred from a case merely existing at the time"
          />
          <StatTile label="Recovery rate" value={`${recoveryRate.toFixed(1)}%`} />
          <StatTile label="₹ still at risk" value={formatPaise(atRiskPaise)} />
          <StatTile
            label="Cross-channel resolutions"
            value={String(crossChannelResolutions.length)}
            accent="text-indigo-600"
            hint="Paid through a different channel than the one that failed"
          />
          <StatTile
            label="Recovery actions prevented"
            value={String(recoveryActionsPrevented)}
            accent="text-indigo-600"
            hint="Reminders/links cancelled because the customer already paid"
          />
          <StatTile
            label="AI vs. fixed-schedule rules"
            value={aiVsBaselineTotal > 0 ? `${divergenceRate.toFixed(0)}% diverged` : "No data yet"}
            accent="text-violet-600"
            hint={`${divergentActions.length} of ${aiVsBaselineTotal} AI decisions chose differently than a naive fixed-schedule rule would have — never executed, recorded only for comparison`}
          />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Approval queue</h2>
            <span className="text-sm text-neutral-500">{pendingActions.length} pending</span>
          </div>
          {pendingActions.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-500">
              Nothing waiting on you — everything within bounds is running autonomously.
            </p>
          ) : (
            <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-neutral-100 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2">Obligation</th>
                    <th className="px-4 py-2">Amount</th>
                    <th className="px-4 py-2">Proposed action</th>
                    <th className="px-4 py-2">Why</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {pendingActions.map((a) => (
                    <tr key={a.id} className="border-t border-neutral-100">
                      <td className="px-4 py-3 font-medium">{a.case.obligation.referenceId}</td>
                      <td className="px-4 py-3">{formatPaise(a.case.obligation.outstandingAmountPaise)}</td>
                      <td className="px-4 py-3">{ACTION_LABELS[a.actionType] ?? a.actionType}</td>
                      <td className="max-w-xs px-4 py-3 text-neutral-600">
                        <p>{a.reason}</p>
                        {a.policyReasoning && a.policyReasoning !== a.reason && (
                          <p className="mt-1 text-xs italic text-neutral-400">{a.policyReasoning}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <ApprovalActions actionId={a.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Active recovery cases</h2>
            <span className="text-sm text-neutral-500">{openCases.length} open</span>
          </div>
          {openCases.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-500">
              No obligations currently mid-recovery.
            </p>
          ) : (
            <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-neutral-100 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2">Obligation</th>
                    <th className="px-4 py-2">Amount</th>
                    <th className="px-4 py-2">Providers tried</th>
                    <th className="px-4 py-2">Case status</th>
                    <th className="px-4 py-2">Next step</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {openCases.map((c) => {
                    const providers = Array.from(new Set(c.obligation.attempts.map((a) => a.provider)));
                    return (
                      <tr key={c.id} className="border-t border-neutral-100">
                        <td className="px-4 py-3 font-medium">{c.obligation.referenceId}</td>
                        <td className="px-4 py-3">{formatPaise(c.obligation.outstandingAmountPaise)}</td>
                        <td className="px-4 py-3">{providers.map((p) => PROVIDER_LABELS[p] ?? p).join(", ")}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5">
                            {c.status}
                            {c.riskLevel === "FRAUD_SUSPECTED" && (
                              <span
                                className="rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700"
                                title="Rapid repeated failed attempts against this obligation — automated recovery is paused pending human review"
                              >
                                Suspected fraud
                              </span>
                            )}
                            {c.riskLevel === "DISPUTE_ACTIVE" && (
                              <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">Dispute</span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-neutral-600">{c.nextAction ? ACTION_LABELS[c.nextAction] ?? c.nextAction : "—"}</td>
                        <td className="px-4 py-3">
                          <CaseControls caseId={c.id} obligationId={c.obligationId} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Recently closed</h2>
          {resolvedObligations.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-500">
              Nothing closed yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-neutral-100 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2">Obligation</th>
                    <th className="px-4 py-2">Amount</th>
                    <th className="px-4 py-2">Outcome</th>
                    <th className="px-4 py-2">Closed at</th>
                  </tr>
                </thead>
                <tbody>
                  {resolvedObligations.map((o) => (
                    <tr key={o.id} className="border-t border-neutral-100">
                      <td className="px-4 py-3 font-medium">{o.referenceId}</td>
                      <td className="px-4 py-3">{formatPaise(o.originalAmountPaise)}</td>
                      <td className="px-4 py-3">
                        {o.status === "CANCELLED" ? (
                          <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700">Written off</span>
                        ) : o.status === "REFUNDED" ? (
                          <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">
                            Refunded{o.refundedAmountPaise < o.originalAmountPaise ? ` (${formatPaise(o.refundedAmountPaise)})` : ""}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                o.resolutionSource === "external" ? "bg-indigo-100 text-indigo-700" : "bg-emerald-100 text-emerald-700"
                              }`}
                            >
                              {PROVIDER_LABELS[o.resolutionSource ?? ""] ?? o.resolutionSource}
                            </span>
                            {o.excessPaidAmountPaise > 0 && (
                              <span
                                className="rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700"
                                title="Paid more than was owed — flagged for human review, not counted as recovered revenue"
                              >
                                Overpaid by {formatPaise(o.excessPaidAmountPaise)}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-neutral-500">{o.resolvedAt?.toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="mb-3 text-base font-semibold">Failures by category</h2>
            <div className="space-y-2 rounded border border-neutral-200 bg-white p-4">
              {byFailureType.length === 0 && <p className="text-sm text-neutral-500">No failures recorded.</p>}
              {byFailureType.map(([type, count]) => (
                <div key={type} className="flex items-center justify-between text-sm">
                  <span>{FAILURE_LABELS[type] ?? type}</span>
                  <span className="font-medium">{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-base font-semibold">Audit trail</h2>
            <div className="max-h-96 space-y-3 overflow-y-auto rounded border border-neutral-200 bg-white p-4">
              {recentAudit.map((log) => (
                <div key={log.id} className={`text-sm ${log.action === "RECOVERY_ACTION_PREVENTED" ? "rounded bg-indigo-50 p-2" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        log.actor === "AI"
                          ? "bg-purple-100 text-purple-700"
                          : log.actor === "POLICY"
                            ? "bg-amber-100 text-amber-700"
                            : log.actor === "MERCHANT"
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-neutral-100 text-neutral-700"
                      }`}
                    >
                      {log.actor}
                    </span>
                    <span className="font-medium">{log.action}</span>
                  </div>
                  <p className="mt-0.5 text-neutral-600">{log.reasoning}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">AI vs. a fixed-schedule rule</h2>
          <p className="mb-3 text-sm text-neutral-500">
            Every AI decision is compared against what a naive, fixed-schedule dunning rule (reminder → link →
            give up, with no calibration or lifecycle/outage awareness) would have proposed instead — the
            baseline is recorded for comparison only and is never executed. This is where the AI actually earns
            its complexity.
          </p>
          <div className="rounded border border-neutral-200 bg-white p-4">
            {divergentActions.length === 0 ? (
              <p className="text-sm text-neutral-500">
                {aiVsBaselineTotal === 0 ? "No decisions recorded yet." : "The AI hasn't diverged from the fixed-schedule rule yet."}
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                {divergenceBreakdown.map(([transition, count]) => (
                  <div key={transition} className="flex items-center justify-between">
                    <span className="text-neutral-600">
                      Rule would <span className="font-medium">{transition.split(" → ")[0]}</span> — AI instead{" "}
                      <span className="font-medium text-violet-700">{transition.split(" → ")[1]}</span>
                    </span>
                    <span className="font-medium">{count}×</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Promise-to-pay tracker</h2>
          <p className="mb-3 text-sm text-neutral-500">
            Every &quot;Record promise to pay&quot; parks the case for 24h, then re-verifies automatically. A promise is
            counted <span className="font-medium text-emerald-700">kept</span> if the obligation was paid at or
            after it was made, <span className="font-medium text-red-700">broken</span> once the 24h window has
            passed with it still unresolved, and <span className="font-medium text-amber-700">pending</span>{" "}
            otherwise. A customer who breaks a promise escalates straight to a human on the next cycle rather than
            getting another automated nudge.
          </p>
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Kept" value={String(promisesKept)} accent="text-emerald-600" />
            <StatTile label="Broken" value={String(promisesBroken)} accent="text-red-600" />
            <StatTile label="Pending" value={String(promisesPending)} accent="text-amber-600" />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold">Webhook integration</h2>
          <div className="space-y-2 rounded border border-neutral-200 bg-white p-4 text-sm">
            <p className="text-neutral-600">
              Point your provider webhooks here to feed real events into your recovery pipeline. Your merchant id is
              appended as a query parameter so events route to your account.
            </p>
            <IntegrationUrl label="Razorpay" path={`/api/webhooks/razorpay?merchant=${merchant.id}`} />
            <IntegrationUrl label="Stripe" path={`/api/webhooks/stripe?merchant=${merchant.id}`} />
            <IntegrationUrl label="External / merchant push" path={`/api/webhooks/external?merchant=${merchant.id}`} />
          </div>
        </section>
      </main>
    </div>
  );
}

function StatTile({ label, value, accent, hint }: { label: string; value: string; accent?: string; hint?: string }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4" title={hint}>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

function IntegrationUrl({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
      <span className="w-40 shrink-0 text-neutral-500">{label}</span>
      <code className="overflow-x-auto rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-800">{path}</code>
    </div>
  );
}
