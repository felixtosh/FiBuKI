/**
 * W3 migration CLI — process entry (chunk 4). Thin wrapper over runCli() in
 * migrate-cli.ts. Kept separate so the library is importable by tests without
 * this file's side effects (vite-node doesn't put the entry path in argv, so
 * an in-module entrypoint guard can't reliably distinguish run-as-script from
 * imported — a dedicated entry file is the clean split). See migrate-cli.ts.
 *
 *   npm run selfhost:import -- --dir <dump> [--dry-run]
 *   npm run selfhost:verify -- --dir <dump>
 */

import { runCli } from "./migrate-cli";

/** Wait for a stream's buffered bytes to flush — process.exit() truncates
 * async writes to a pipe/file, which would otherwise drop the whole report. */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0) resolve();
    else stream.once("drain", resolve);
  });
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  // Force termination (a real pg Pool would otherwise keep the loop alive),
  // but only after stdout/stderr have drained.
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}

void main();
