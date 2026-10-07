export const dynamic = "force-dynamic";

/**
 * The shared benchmark data, for people an admin allowed to take it
 * (docs/benchmarking.md).
 *
 *   GET /api/admin/benchmark                  the versions the caller may download
 *   GET /api/admin/benchmark?version=bench-…  that version's file, logged
 *
 * The caller is a login, or a personal API key sent as `Authorization: Bearer
 * fk_…` (an agent or a script pulling a version). Either way the "may
 * download" switch decides, never a request field. A person without it gets
 * 403 whoever they are; a version that is gone or never was is 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, getAdminBucket } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import {
  apiKeyOwner,
  downloadBenchmarkVersion,
  listDownloadableVersions,
} from "@/functions/src/benchmark/download";

async function caller(request: NextRequest): Promise<{ uid: string; via: "login" | "apiKey" } | null> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (bearer.startsWith("fk_")) {
    const uid = await apiKeyOwner(getAdminDb() as unknown as FirebaseFirestore.Firestore, bearer);
    return uid ? { uid, via: "apiKey" } : null;
  }
  return { uid: await getServerUserIdWithFallback(request), via: "login" };
}

export async function GET(request: NextRequest) {
  try {
    const who = await caller(request);
    if (!who) return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    const db = getAdminDb() as unknown as FirebaseFirestore.Firestore;

    const version = request.nextUrl.searchParams.get("version");
    if (version === null) {
      const versions = await listDownloadableVersions(db, who.uid);
      if (versions === null) {
        return NextResponse.json({ error: "You may not download benchmark data." }, { status: 403 });
      }
      return NextResponse.json({ versions });
    }

    const outcome = await downloadBenchmarkVersion(db, getAdminBucket(), who.uid, version, who.via);
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return new NextResponse(new Uint8Array(outcome.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${outcome.version}.json"`,
        "X-Benchmark-Checksum": outcome.checksum,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[benchmark] download failed:", error);
    return NextResponse.json({ error: "Download failed" }, { status: 500 });
  }
}
