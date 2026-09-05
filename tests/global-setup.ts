import { execSync } from "child_process";
import path from "path";

// Applies migrations against a dedicated Postgres test database (TEST_DATABASE_URL —
// keep this pointed at a database separate from your real DATABASE_URL, since
// `migrate reset` drops everything in it) so the engine tests exercise real
// Prisma queries (retry counts, nudge counts, etc.) instead of mocking away
// the exact logic under test. Previously this spun up a throwaway local
// SQLite file; that's no longer possible now that the app runs on Postgres
// (see prisma/schema.prisma) for real deployment.
export async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set — tests need a Postgres database of their own " +
        "(e.g. a second free database/branch in the same Neon project as DATABASE_URL). " +
        "Never point this at the same database as DATABASE_URL: `migrate reset` drops everything in it."
    );
  }

  execSync("npx prisma migrate reset --force --skip-generate --skip-seed", {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
