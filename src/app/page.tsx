import Link from "next/link";

const PRINCIPLES = [
  {
    title: "One engine, every provider",
    body: "Razorpay, Stripe, and any provider after them plug in as adapters that normalize their own payload into one universal event model. The core platform never depends on a specific provider's shape — add a new one without touching recovery logic.",
  },
  {
    title: "One engine, every business model",
    body: "E-commerce orders, SaaS subscriptions, EdTech installments, marketplace payouts — whatever a merchant calls it internally becomes one thing on this side: a payment obligation. The recovery logic doesn't change per business type.",
  },
  {
    title: "Obligation-centric, not transaction-centric",
    body: "The system tracks what a customer owes, not any single provider's transaction. One obligation accumulates payment attempts from every channel it's tried on, and resolves the moment any of them succeeds.",
  },
  {
    title: "AI proposes, policy decides",
    body: "The AI layer picks from a fixed set of actions; it never executes anything itself. A deterministic policy engine enforces your retry caps, message limits, contact windows, and approval thresholds — guardrails it cannot bypass.",
  },
];

const PROVIDERS = ["Razorpay", "Stripe", "PayPal", "Adyen", "Cashfree", "+ any provider"];
const PLATFORMS = ["E-commerce", "SaaS billing", "EdTech", "Marketplaces", "Subscriptions", "+ any platform"];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="text-sm font-semibold tracking-tight">Universal Recovery</span>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/login" className="text-neutral-600 hover:text-neutral-900">
              Sign in
            </Link>
            <Link href="/signup" className="rounded bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700">
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-4xl px-6 py-20 text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 sm:text-5xl">
            Universal payment recovery.
            <br />
            Every provider. Every platform. One engine.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-neutral-600">
            A provider-agnostic, AI-powered recovery and reconciliation layer that sits above however your business
            takes payments. It tracks what a customer actually owes — not any single provider&apos;s transaction — and
            recovers it safely, wherever they end up paying.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/signup" className="rounded bg-neutral-900 px-6 py-3 text-sm font-medium text-white hover:bg-neutral-700">
              Get started free
            </Link>
            <Link href="/login" className="rounded border border-neutral-300 px-6 py-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Sign in
            </Link>
          </div>
        </section>

        <section className="border-t border-neutral-200 bg-neutral-50 py-16">
          <div className="mx-auto max-w-4xl px-6">
            <p className="text-center text-sm uppercase tracking-wide text-neutral-500">Works across</p>
            <div className="mt-6 grid gap-8 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Payment providers</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {PROVIDERS.map((p) => (
                    <span key={p} className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-sm text-neutral-700">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Business platforms</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <span key={p} className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-sm text-neutral-700">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-center text-2xl font-semibold text-neutral-900">How universal recovery works</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded border border-neutral-200 p-5">
                <h3 className="font-medium text-neutral-900">{p.title}</h3>
                <p className="mt-2 text-sm text-neutral-600">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-neutral-200 bg-neutral-900 py-16 text-center">
          <h2 className="text-2xl font-semibold text-white">Set it up in minutes.</h2>
          <p className="mx-auto mt-3 max-w-xl text-neutral-300">
            Create an account, accept what the agent is authorized to do, and point your provider webhooks at your
            dashboard.
          </p>
          <Link href="/signup" className="mt-6 inline-block rounded bg-white px-6 py-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100">
            Get started free
          </Link>
        </section>
      </main>

      <footer className="border-t border-neutral-200 py-8 text-center text-xs text-neutral-400">
        Built for the Razorpay Buildathon · test mode
      </footer>
    </div>
  );
}
