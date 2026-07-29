/**
 * W3 chunk 4 — migration CLI (runCli) coverage. Exercises the operator front
 * door end to end against the shims: argv parsing, exit codes, and the verify
 * gate (exit 1 before import, exit 0 after). The heavy import/verify semantics
 * are proven in migrate-import*.test.ts; this pins the CLI wiring on top.
 *
 * Shared-store rule (compose CI): every collection/object path is unique per
 * run — see migrate-import-storage.test.ts:24.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { runCli, parseArgs } from "./migrate-cli";
import { _resetStorageForTests } from "./storage-shim";

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `w3cli_${RUN}`;
const OBJ = `files/w3cli${RUN}/receipt.pdf`;
const OBJ_BYTES = Buffer.from(`cli fixture ${RUN}`);

let hadStorageEnv: string | undefined;
let forcedMemory = false;

beforeAll(() => {
  hadStorageEnv = process.env.FIBUKI_STORAGE;
  if (!process.env.FIBUKI_STORAGE && !process.env.FIBUKI_S3_ENDPOINT) {
    process.env.FIBUKI_STORAGE = "memory";
    forcedMemory = true;
    _resetStorageForTests();
  }
});

afterAll(() => {
  if (forcedMemory) {
    if (hadStorageEnv === undefined) delete process.env.FIBUKI_STORAGE;
    else process.env.FIBUKI_STORAGE = hadStorageEnv;
    _resetStorageForTests();
  }
});

/** A minimal version-1 dump: one collection doc + one storage object. */
async function writeDump(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "w3-cli-dump-"));
  await fs.mkdir(path.join(dir, "collections"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "collections", "c1.ndjson"),
    JSON.stringify({ id: `doc_${RUN}`, data: { amount: 5, note: "hi" } }) + "\n",
  );

  await fs.mkdir(path.join(dir, "objects", path.dirname(OBJ)), { recursive: true });
  await fs.writeFile(path.join(dir, "objects", OBJ), OBJ_BYTES);
  await fs.writeFile(
    path.join(dir, "storage-manifest.ndjson"),
    JSON.stringify({ path: OBJ, size: OBJ_BYTES.length, md5: createHash("md5").update(OBJ_BYTES).digest("hex") }) + "\n",
  );

  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      exportedAt: "2026-07-22T00:00:00.000Z",
      collections: [{ path: COLLECTION, file: "c1.ndjson", count: 1 }],
      users: null,
      storage: { manifest: "storage-manifest.ndjson", objectsDir: "objects", count: 1, bytes: OBJ_BYTES.length },
    }),
  );
  return dir;
}

/** Collect a runCli invocation's stdout/stderr with its exit code. */
async function invoke(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("W3 migration CLI — argv parsing", () => {
  it("rejects an unknown command with a usage error", () => {
    expect(parseArgs(["bogus"])).toEqual({ error: expect.stringContaining("unknown command") });
  });
  it("requires --dir", () => {
    expect(parseArgs(["import"])).toEqual({ error: expect.stringContaining("--dir") });
  });
  it("refuses --dry-run for verify", () => {
    expect(parseArgs(["verify", "--dir", "/x", "--dry-run"])).toEqual({
      error: expect.stringContaining("dry-run"),
    });
  });
  it("parses an import with --dir and --dry-run", () => {
    expect(parseArgs(["import", "-d", "/x", "--dry-run"])).toEqual({
      command: "import",
      dir: "/x",
      dryRun: true,
    });
  });
  it("treats no args / --help as help", () => {
    expect(parseArgs([])).toEqual({ help: true });
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });
});

describe("W3 migration CLI — exit codes", () => {
  it("no command prints usage and exits 0", async () => {
    const { code, out } = await invoke([]);
    expect(code).toBe(0);
    expect(out).toContain("selfhost:import");
  });

  it("usage error exits 2", async () => {
    const { code, err } = await invoke(["import"]);
    expect(code).toBe(2);
    expect(err).toContain("--dir");
  });

  it("verify fails (exit 1) before import, dry-run writes nothing, import then verify passes (exit 0)", async () => {
    const dir = await writeDump();

    const before = await invoke(["verify", "--dir", dir]);
    expect(before.code).toBe(1);
    expect(before.out).toContain("verify — FAIL");

    const dry = await invoke(["import", "--dir", dir, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("DRY RUN");
    // dry-run wrote nothing, so verify still fails
    expect((await invoke(["verify", "--dir", dir])).code).toBe(1);

    const imported = await invoke(["import", "--dir", dir]);
    expect(imported.code).toBe(0);

    const after = await invoke(["verify", "--dir", dir]);
    expect(after.code).toBe(0);
    expect(after.out).toContain("verify — PASS");
  });

  it("maps a broken dump (missing directory) to exit 1, not a crash", async () => {
    const { code, err } = await invoke(["verify", "--dir", "/no/such/dump/path"]);
    expect(code).toBe(1);
    expect(err).toContain("error:");
  });
});
