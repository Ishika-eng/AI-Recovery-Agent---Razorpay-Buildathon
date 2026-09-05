import { defineConfig } from "vitest/config";
import path from "path";
import { config } from "dotenv";

// Needed now that TEST_DATABASE_URL lives in .env rather than being a
// hardcoded literal (the old SQLite path never needed this — the test file
// path was hardcoded directly below).
config();

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    // Test files share one Postgres database as their DB; running them
    // across workers races resetDb() in one file against creates in another.
    fileParallelism: false,
    // The 5s default assumed a local SQLite file. Against a real networked
    // Postgres, a test that chains several sequential DB round-trips (e.g. a
    // full recovery cycle) can legitimately take longer than that — and a
    // timed-out test's in-flight query chain doesn't actually get cancelled,
    // it keeps running and can race the *next* test's resetDb(), corrupting
    // it. Raising this isn't padding for slow code, it's matching the
    // timeout to a real network round-trip instead of a local file read.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      // Force these off regardless of what's in .env — tests must never
      // depend on a live external API or secret, or a test run's behavior
      // silently depends on which developer's machine (and which real
      // credentials happen to be configured on it) runs it.
      // GROQ_API_KEY: without this, a real key configured for local dev
      // (see src/lib/llm.ts) makes the Hinglish-voice-script tests silently
      // call the real Groq API, turning a deterministic unit test into a
      // slow, flaky network test.
      // RAZORPAY_WEBHOOK_SECRET/STRIPE_WEBHOOK_SECRET: found live while
      // setting up the real webhook — with a real secret configured,
      // providers/razorpay.ts's verifyWebhook() actually validates HMAC
      // signatures, which every webhook test's fake unsigned payload then
      // correctly fails, rejecting webhooks the tests expect to process.
      // RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET: found the same way — with real
      // keys configured, every GENERATE_PAYMENT_LINK/
      // OFFER_ALTERNATIVE_PAYMENT_METHOD test was silently creating real
      // Razorpay payment links (see paymentLink.ts) instead of exercising
      // the documented "not configured" fallback the tests actually mean
      // to cover, and re-running the suite risks the exact
      // reference_id-already-exists collision this same session hit live.
      GROQ_API_KEY: "",
      RAZORPAY_WEBHOOK_SECRET: "",
      STRIPE_WEBHOOK_SECRET: "",
      RAZORPAY_KEY_ID: "",
      RAZORPAY_KEY_SECRET: "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
