/**
 * /api/admin/replay serves one account's reports: the caller's (docs/replay.md).
 * The admin check reads the verified token only, so it is stubbed here; the
 * cross-user suite covers the non-admin refusal through the real check.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

const FELIX = "felix-uid";
const STEFAN = "stefan-uid";
let caller = FELIX;
let admin = true;

vi.mock("@/lib/auth/get-server-user", () => ({
  getServerUserIdWithFallback: async () => caller,
  isServerUserAdmin: async () => admin,
  unauthorizedResponse: () => null,
}));

const get = async (query = "") => {
  const { GET } = await import("@/app/api/admin/replay/route");
  return GET(new NextRequest(new URL(`/api/admin/replay${query}`, "https://web.test")));
};

const diff = (label: string) => ({
  base: { label: "main", gitSha: "aaaaaaa", builtAt: "2026-10-05T10:00:00.000Z" },
  head: { label: "pr", gitSha: "bbbbbbb", builtAt: "2026-10-05T10:01:00.000Z", setLabel: label, setExportedAt: "2026-10-05T09:00:00.000Z" },
  files: { total: 3, unchanged: 2, rows: [{ id: "f1", name: `${label}-invoice.pdf` }] },
  transactions: { total: 5, unchanged: 5, rows: [] },
  counts: { now_agrees: 1, now_disagrees: 0, contradicts: 0, unverified: 0 },
});

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "replay-reports-"));
  process.env.FIBUKI_REPLAY_DIR = dir;
  for (const pr of ["660", "662"]) {
    await fs.mkdir(path.join(dir, pr));
    await fs.writeFile(path.join(dir, pr, `${FELIX}.json`), JSON.stringify(diff("Felix")));
    await fs.writeFile(path.join(dir, pr, `${FELIX}.md`), `# Felix report ${pr}`);
  }
  await fs.writeFile(path.join(dir, "662", `${STEFAN}.json`), JSON.stringify(diff("Stefan")));
  await fs.writeFile(path.join(dir, "662", `${STEFAN}.md`), "# Stefan report 662 SECRET");
  await fs.writeFile(path.join(dir, "notes.md"), "not a report");
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("/api/admin/replay", () => {
  it("lists the caller's runs only, newest first", async () => {
    caller = STEFAN;
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.runs.map((r: { pr: number }) => r.pr)).toEqual([662]);

    caller = FELIX;
    const mine = await (await get()).json();
    expect(mine.runs.map((r: { pr: number }) => r.pr)).toEqual([660, 662]);
    expect(mine.runs[0]).toMatchObject({ files: { total: 3, changed: 1 }, counts: { now_agrees: 1 } });
  });

  it("serves the caller's diff and Markdown, never another account's", async () => {
    caller = FELIX;
    const json = await (await get("?pr=662")).json();
    expect(json.head.setLabel).toBe("Felix");
    const md = await (await get("?pr=662&format=md")).text();
    expect(md).toContain("Felix report 662");
    expect(md).not.toContain("SECRET");

    // A PR with no report for this account answers like one that does not exist.
    caller = STEFAN;
    expect((await get("?pr=660")).status).toBe(404);
    expect((await get("?pr=999")).status).toBe(404);
  });

  it("refuses a path-shaped pr and a non-admin", async () => {
    caller = FELIX;
    for (const pr of ["../660", "660/..", "%2e%2e", "notes", ""]) {
      expect((await get(`?pr=${pr}`)).status).toBe(404);
    }
    admin = false;
    expect((await get()).status).toBe(403);
    expect((await get("?pr=660")).status).toBe(403);
    admin = true;
  });

  it("says so when no report directory is configured", async () => {
    const saved = process.env.FIBUKI_REPLAY_DIR;
    delete process.env.FIBUKI_REPLAY_DIR;
    const body = await (await get()).json();
    expect(body).toEqual({ runs: [], configured: false });
    process.env.FIBUKI_REPLAY_DIR = saved;
  });
});
