import { execSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import path from "path";

// Spins up a throwaway SQLite DB and applies migrations against it, so the
// engine tests exercise real Prisma queries (retry counts, nudge counts,
// etc.) instead of mocking away the exact logic under test.
const TEST_DB_PATH = path.resolve(__dirname, "../prisma/test.db");

export async function setup() {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  execSync("npx prisma migrate deploy", {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "inherit",
  });
}

export async function teardown() {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const journal = `${TEST_DB_PATH}-journal`;
  if (existsSync(journal)) unlinkSync(journal);
}
