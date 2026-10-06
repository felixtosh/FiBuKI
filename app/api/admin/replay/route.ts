export const dynamic = "force-dynamic";

/**
 * Replay reports for the signed-in admin's own account (docs/replay.md).
 *
 * The box writes one report per PR and account under FIBUKI_REPLAY_DIR
 * (`<pr>/<uid>.json`, the diff; `<pr>/<uid>.md`, the same as Markdown). A
 * report holds real bank lines, so this route serves exactly one account's
 * files: the caller's. Another admin's report answers as if it did not exist.
 *
 *   GET /api/admin/replay            the caller's runs, newest first
 *   GET /api/admin/replay?pr=660     the caller's diff for that PR
 *   GET /api/admin/replay?pr=660&format=md   the Markdown
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, isServerUserAdmin, unauthorizedResponse } from "@/lib/auth/get-server-user";

const PR = /^\d{1,7}$/;
/** A uid that could not name a path outside its own file. */
const UID = /^[A-Za-z0-9_-]{1,128}$/;

function reportsDir(): string | null {
  const dir = process.env.FIBUKI_REPLAY_DIR;
  return dir ? path.resolve(dir) : null;
}

/** `<dir>/<pr>/<uid>.<ext>`, or null when any part could escape the directory. */
function reportPath(dir: string, pr: string, uid: string, ext: "json" | "md"): string | null {
  if (!PR.test(pr) || !UID.test(uid)) return null;
  const file = path.resolve(dir, pr, `${uid}.${ext}`);
  return file.startsWith(dir + path.sep) ? file : null;
}

interface RunListEntry {
  pr: number;
  builtAt: string;
  head: string | null;
  base: string | null;
  files: { total: number; changed: number };
  transactions: { total: number; changed: number };
  counts: Record<string, number>;
}

async function listRuns(dir: string, uid: string): Promise<RunListEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const runs: RunListEntry[] = [];
  for (const name of entries) {
    if (!PR.test(name)) continue;
    const file = reportPath(dir, name, uid, "json");
    if (!file) continue;
    try {
      const diff = JSON.parse(await fs.readFile(file, "utf8"));
      runs.push({
        pr: Number(name),
        builtAt: diff.head?.builtAt ?? "",
        head: diff.head?.gitSha ?? null,
        base: diff.base?.gitSha ?? null,
        files: { total: diff.files?.total ?? 0, changed: diff.files?.rows?.length ?? 0 },
        transactions: { total: diff.transactions?.total ?? 0, changed: diff.transactions?.rows?.length ?? 0 },
        counts: diff.counts ?? {},
      });
    } catch {
      // No report for this account on that PR, or an unreadable one: not listed.
    }
  }
  return runs.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
}

export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!(await isServerUserAdmin(request))) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    const dir = reportsDir();
    if (!dir) return NextResponse.json({ runs: [], configured: false });

    const pr = request.nextUrl.searchParams.get("pr");
    if (pr === null) {
      return NextResponse.json({ runs: await listRuns(dir, userId), configured: true });
    }

    const format = request.nextUrl.searchParams.get("format") === "md" ? "md" : "json";
    const file = reportPath(dir, pr, userId, format);
    if (!file) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    let body: string;
    try {
      body = await fs.readFile(file, "utf8");
    } catch {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }
    if (format === "md") {
      return new NextResponse(body, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="replay-${pr}.md"`,
        },
      });
    }
    return new NextResponse(body, { headers: { "Content-Type": "application/json" } });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[AdminReplay] Error:", error);
    return NextResponse.json({ error: "Could not read replay reports" }, { status: 500 });
  }
}
