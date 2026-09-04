import { redirect } from "next/navigation";
import { getCurrentMerchant } from "@/lib/dal";
import { acceptTermsAction } from "@/app/actions/onboarding";

const TERMS = [
  {
    title: "The agent tracks obligations, not transactions",
    body: "It reconciles every payment attempt across Razorpay, Stripe, and any other channel against the underlying order/invoice/subscription — never against a single provider's transaction in isolation.",
  },
  {
    title: "It re-verifies before every customer-facing action",
    body: "Immediately before sending a reminder, generating a payment link, or retrying, it re-checks whether the obligation is still unpaid. It will never contact a customer for money they've already paid.",
  },
  {
    title: "It operates within limits you control",
    body: "Auto-retry caps, message caps, a minimum contact gap, contact-window hours, and an auto-approve amount ceiling are all enforced by a deterministic policy layer the AI cannot override. You can change these later from your dashboard.",
  },
  {
    title: "Anything outside those limits waits for you",
    body: "High-value cases, escalations, and anything that would exceed a configured cap are queued in your approval queue instead of executing automatically.",
  },
];

export default async function OnboardingPage() {
  const merchant = await getCurrentMerchant();
  // See the matching comment in dashboard/page.tsx — an orphaned session
  // cookie must be cleared via a route handler, not redirected to /login
  // directly, or the proxy bounces it straight back here forever.
  if (!merchant) redirect("/api/auth/clear-session");
  if (merchant.termsAcceptedAt) redirect("/dashboard");

  return (
    <div className="onboarding-page">
      <div className="onboarding-card">
      <div className="onboarding-top"><span className="brand-mark">↗</span> Universal Recovery</div>
      <div className="onboarding-intro">
      <h1>Before {merchant.name} goes live</h1>
      <p className="mt-2 text-neutral-600">
        Here&apos;s what the recovery agent is authorized to do on your behalf. You can review and adjust the limits
        any time after setup.
      </p>

      <div className="onboarding-terms">
        {TERMS.map((term) => (
          <div key={term.title} className="rounded border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">{term.title}</h2>
            <p className="mt-1 text-sm text-neutral-600">{term.body}</p>
          </div>
        ))}
      </div>

      <form action={acceptTermsAction} className="mt-8">
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-3 text-sm font-medium text-white hover:bg-neutral-700 sm:w-auto"
        >
          Accept and go to dashboard
        </button>
      </form>
      </div>
      </div>
    </div>
  );
}
