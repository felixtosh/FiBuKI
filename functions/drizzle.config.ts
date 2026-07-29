import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is the migration AUTHOR only: `npx drizzle-kit generate`
 * diffs src/selfhost/db/schema.ts against the snapshots in ./drizzle/meta
 * and writes a readable SQL migration. Applying migrations is done at boot
 * by src/selfhost/db/migrate.ts (works against both PGlite and node-postgres
 * through one code path), NOT by drizzle-kit push/migrate.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/selfhost/db/schema.ts",
  out: "./drizzle",
});
