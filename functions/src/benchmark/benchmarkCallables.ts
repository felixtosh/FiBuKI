/**
 * Admin callables for the shared benchmark data (benchmarkData.ts). Every one
 * refuses a caller who is not an admin, decided from the verified token only.
 */

import { getAuth } from "firebase-admin/auth";
import { createCallable, HttpsError } from "../utils/createCallable";
import { isAdminCaller } from "../utils/adminCaller";
import {
  buildVersion,
  deleteVersion,
  listVersions,
  setMember,
  type BenchmarkMember,
  type BenchmarkVersionSummary,
  type SetMemberRequest,
} from "./benchmarkData";

function requireAdmin(request: { auth?: { token?: Record<string, unknown> } | null }): void {
  if (!isAdminCaller(request.auth)) throw new HttpsError("permission-denied", "Admin access required");
}

/** "invalid-argument: ..." from the data module becomes that HttpsError. */
function asHttpsError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(invalid-argument|failed-precondition|not-found): (.*)$/.exec(message);
  if (match) throw new HttpsError(match[1] as "invalid-argument", match[2]);
  throw error;
}

/** A short name for an account in reports: the first word of its display name, else its email. */
export async function accountLabel(uid: string): Promise<string> {
  try {
    const user = await getAuth().getUser(uid);
    const first = (user.displayName ?? "").trim().split(/\s+/)[0];
    return first || user.email || uid;
  } catch {
    return uid;
  }
}

export const setBenchmarkMemberCallable = createCallable<SetMemberRequest, { member: BenchmarkMember }>(
  { name: "setBenchmarkMember" },
  async (ctx, request) => {
    requireAdmin(ctx.request);
    try {
      return { member: await setMember(ctx.db, ctx.userId, request ?? ({} as SetMemberRequest)) };
    } catch (error) {
      asHttpsError(error);
    }
  }
);

export const buildBenchmarkVersionCallable = createCallable<Record<string, never>, { version: BenchmarkVersionSummary }>(
  { name: "buildBenchmarkVersion" },
  async (ctx) => {
    requireAdmin(ctx.request);
    try {
      return { version: await buildVersion(ctx.db, ctx.userId, accountLabel) };
    } catch (error) {
      asHttpsError(error);
    }
  }
);

export const listBenchmarkVersionsCallable = createCallable<Record<string, never>, { versions: BenchmarkVersionSummary[] }>(
  { name: "listBenchmarkVersions" },
  async (ctx) => {
    requireAdmin(ctx.request);
    return { versions: await listVersions(ctx.db) };
  }
);

export const deleteBenchmarkVersionCallable = createCallable<{ versionId: string }, { success: true }>(
  { name: "deleteBenchmarkVersion" },
  async (ctx, request) => {
    requireAdmin(ctx.request);
    if (typeof request?.versionId !== "string" || !request.versionId) {
      throw new HttpsError("invalid-argument", "versionId is required");
    }
    try {
      await deleteVersion(ctx.db, request.versionId);
      return { success: true as const };
    } catch (error) {
      asHttpsError(error);
    }
  }
);
