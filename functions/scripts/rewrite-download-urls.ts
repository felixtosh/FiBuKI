/**
 * Entry point for the post-migration download-URL rewrite.
 *
 * Runs on the self-host host with the same environment the API uses (it writes
 * through the shim, so it needs DATABASE_URL, FIBUKI_STORAGE and
 * FIBUKI_PUBLIC_URL). Never touches Firebase.
 *
 *   npm run selfhost:rewrite-urls -- --dry-run
 *   npm run selfhost:rewrite-urls
 *
 * Separate entry rather than a third migrate-cli command: that CLI is typed to
 * import|verify and has tests pinning its argument parsing, and this is a
 * one-off remediation rather than part of the migration contract.
 *
 * Exit codes: 0 success (including nothing to do), 1 unresolved documents
 * remain, 2 usage/config error.
 */

import { rewriteDownloadUrls } from "../src/selfhost/migrate-rewrite-urls";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(
      "rewrite-download-urls — repoint migrated downloadUrl fields at the " +
        "self-host blob plane\n\n" +
        "  --dry-run   report what would change, write nothing\n",
    );
    process.exit(0);
  }
  const dryRun = args.includes("--dry-run");

  console.log(
    `rewriting download URLs${dryRun ? " (dry run)" : ""} -> ${process.env.FIBUKI_PUBLIC_URL}`,
  );

  let report;
  try {
    report = await rewriteDownloadUrls({ dryRun });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.rewritten}/${report.candidates} Firebase URLs ` +
      `${dryRun ? "would be " : ""}rewritten`,
  );
  if (report.unresolved.length > 0) {
    console.error(`unresolved: ${report.unresolved.length} — see the warning above`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
