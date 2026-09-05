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
      // Force this off regardless of what's in .env — tests must never
      // depend on a live external API. Without this, having a real
      // GROQ_API_KEY configured for local dev (see src/lib/llm.ts) makes
      // the Hinglish-voice-script tests silently call the real Groq API,
      // turning a deterministic unit test into a slow, flaky network test.
      GROQ_API_KEY: "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
