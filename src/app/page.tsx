import Link from "next/link";
import GhostFibers from "@/components/GhostFibers";
import { DarkBodyBackground } from "@/components/DarkBodyBackground";
import { LandingNav } from "@/components/LandingNav";
import { ScrollReveal } from "@/components/ScrollReveal";
import BlurText from "@/components/BlurText";
import { SpecularLinkButton } from "@/components/SpecularLinkButton";

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
    <div className="relative min-h-screen bg-neutral-950 text-white">
      <DarkBodyBackground />
      {/* The animated canvas is deliberately confined to a fixed-height
          block, not stretched across the whole page. Tried that first —
          this shader's glow/vignette terms are single, non-repeating
          radial gradients (not periodic), so stretched over a much
          taller canvas they only ever light up once, near its vertical
          center, and everywhere else reads as flat near-black — no
          amount of prop-tuning fixed that, it's how the shader itself
          is built. This is the standard, reliable version of "the
          background extends the whole way down": the animation lives
          where it actually looks good (roughly one viewport tall), a
          gradient fades its bottom edge into the flat `bg-neutral-950`
          this root div already carries, and that same flat dark colour
          — not an animated one — continues, genuinely unbroken, for
          however far the page scrolls. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-screen min-h-[640px]">
        <GhostFibers
          lineColor="#4036a8"
          glowColor="#6b66ff"
          speed={0.18}
          scale={1.7}
          layers={5}
          glowIntensity={1.35}
          brightness={2.2}
          blueBoost={1}
          vignette={0.9}
          grain={0.04}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-neutral-950" />
      </div>

      <header className="relative z-10 border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="text-sm font-semibold tracking-tight">Universal Recovery</span>
          <LandingNav />
        </div>
      </header>

      <main className="relative z-10">
        <section className="px-6 py-24 text-center sm:py-28">
          <div className="mx-auto max-w-4xl">
            <h1 className="sr-only">Universal payment recovery. Every provider. Every platform. One engine.</h1>
            <BlurText
              text="Universal payment recovery. Every provider. Every platform. One engine."
              delay={90}
              animateBy="words"
              direction="top"
              className="justify-center text-center text-4xl font-semibold tracking-tight text-white sm:text-5xl"
            />
            <p className="mx-auto mt-6 max-w-2xl text-lg text-neutral-300">
              A provider-agnostic, AI-powered recovery and reconciliation layer that sits above however your business
              takes payments. It tracks what a customer actually owes — not any single provider&apos;s transaction — and
              recovers it safely, wherever they end up paying.
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
              <SpecularLinkButton
                href="/signup"
                size="md"
                radius={10}
                tint="#ffffff"
                tintOpacity={1}
                textColor="#171717"
                lineColor="#ffffff"
                baseColor="#d4d4d4"
                proximity={280}
              >
                Get started free
              </SpecularLinkButton>
              <Link href="/login" className="rounded border border-white/30 px-6 py-3 text-sm font-medium text-white hover:bg-white/10">
                Sign in
              </Link>
            </div>
          </div>
        </section>

        <ScrollReveal><section className="border-t border-white/10 py-16">
          <div className="mx-auto max-w-4xl px-6">
            <p className="text-center text-sm uppercase tracking-wide text-neutral-200 [text-shadow:0_1px_8px_rgba(0,0,0,.6)]">Works across</p>
            <div className="mt-6 grid gap-8 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-200 [text-shadow:0_1px_8px_rgba(0,0,0,.6)]">Payment providers</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {PROVIDERS.map((p) => (
                    <span
                      key={p}
                      className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm text-neutral-100 backdrop-blur-sm"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-200 [text-shadow:0_1px_8px_rgba(0,0,0,.6)]">Business platforms</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <span
                      key={p}
                      className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm text-neutral-100 backdrop-blur-sm"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section></ScrollReveal>

        <ScrollReveal delay={80}><section className="border-t border-white/10 px-6 py-16">
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center text-2xl font-semibold text-white">How universal recovery works</h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-2">
              {PRINCIPLES.map((p) => (
                <div key={p.title} className="rounded border border-white/15 bg-white/5 p-5 backdrop-blur-sm">
                  <h3 className="font-medium text-white">{p.title}</h3>
                  <p className="mt-2 text-sm text-neutral-300">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section></ScrollReveal>

        <ScrollReveal delay={120}><section className="border-t border-white/10 py-16 text-center">
          <h2 className="text-2xl font-semibold text-white">Set it up in minutes.</h2>
          <p className="mx-auto mt-3 max-w-xl text-neutral-300">
            Create an account, accept what the agent is authorized to do, and point your provider webhooks at your
            dashboard.
          </p>
          <div className="mt-6">
            <SpecularLinkButton
              href="/signup"
              size="md"
              radius={10}
              tint="#ffffff"
              tintOpacity={1}
              textColor="#171717"
              lineColor="#ffffff"
              baseColor="#d4d4d4"
              proximity={280}
            >
              Get started free
            </SpecularLinkButton>
          </div>
        </section></ScrollReveal>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-8 text-center text-xs text-neutral-500">
        Built for the Razorpay Buildathon · test mode
      </footer>
    </div>
  );
}
