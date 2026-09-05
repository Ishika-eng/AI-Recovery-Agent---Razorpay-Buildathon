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
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
