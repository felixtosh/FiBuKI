/**
 * The Chrome extension's upload writes through the duplicate guard (#182).
 *
 * The write point is `functions/src/files/createFileRecord`, and every path in
 * `functions/src` was moved behind it. This route was not: it computed a
 * `contentHash`, ran no lookup, and wrote `files` itself — so re-collecting an
 * invoice the user already had landed a second File that the guard never saw,
 * one extraction and one partner match later.
 *
 * The claim here is the same one every other ingestion path is held to: a
 * second upload of identical bytes returns the first File and creates nothing.
 * `duplicate-guard.test.ts` walks `app` as well as `functions/src` now, which
 * is what stops the route drifting back to its own write; this pins what the
 * routing actually buys the extension.
 *
 * Covers repo-root app/api/browser/upload/route.ts, so it runs under
 * vitest.api-smoke.config.ts ONLY (needs the root dependency tree):
 *
 *   cd functions && npx vitest run src/api-smoke/browser-upload-duplicate.test.ts \
 *     --config vitest.api-smoke.config.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { setupRouteHarness } from "./route-harness";

// Learn mode connects through the connect callable, as the user (#612): the
// File Connection writer, which has its own suite, makes the connection.
const connects = vi.hoisted(() => [] as Array<{ name: string; data: unknown; token?: string }>);
vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async (name: string, data: unknown, token?: string) => {
    connects.push({ name, data, token });
    return { success: true, connectionId: "c", alreadyConnected: false };
  },
}));

const { store, uploads } = setupRouteHarness();

const USER = "user-1";
const URL = "http://localhost/api/browser/upload";

/** What the extension posts: multipart, with the collected bytes as a File. */
function upload(
  bytes: string,
  fields: Record<string, string> = {},
  fileName = "rechnung.pdf",
  uid = USER
) {
  const form = new FormData();
  form.append("file", new File([bytes], fileName, { type: "application/pdf" }));
  form.append("sourceUrl", "https://shop.example.at/orders/1");
  form.append("sourceRunId", "run-1");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  return new NextRequest(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${uid}` },
    body: form,
  });
}

async function post(request: NextRequest) {
  const { POST } = await import("@/app/api/browser/upload/route");
  return POST(request);
}

/** Every File the store holds for our user. */
const filesOnRecord = () =>
  store
    .collection("files")
    .where("userId", "==", USER)
    .get()
    .then((snapshot) => snapshot.docs);

describe("POST /api/browser/upload", () => {
  it("writes a File carrying the content hash of the collected bytes", async () => {
    const bytes = "%PDF-1.4 one invoice";
    const res = await post(upload(bytes));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { fileId: string; duplicate: boolean };
    expect(body.duplicate).toBe(false);

    const written = (await filesOnRecord())[0];
    expect(written.id).toBe(body.fileId);
    expect(written.data()?.contentHash).toBe(
      createHash("sha256").update(Buffer.from(bytes)).digest("hex")
    );
  });

  it("returns the existing File and creates nothing on a second upload of identical bytes", async () => {
    const bytes = "%PDF-1.4 one invoice";

    const first = (await (await post(upload(bytes))).json()) as { fileId: string };
    // The extension re-collects the same order page: same bytes, new run, and
    // the browser's own name for the download.
    const second = (await (
      await post(upload(bytes, { sourceRunId: "run-2" }, "rechnung (1).pdf"))
    ).json()) as { fileId: string; duplicate: boolean };

    expect(second.fileId).toBe(first.fileId);
    expect(second.duplicate).toBe(true);
    expect(await filesOnRecord()).toHaveLength(1);
    // And it did not spend a second upload on bytes we already hold.
    expect(uploads).toHaveLength(1);
  });

  it("still connects the existing File when the duplicate arrives in learn mode", async () => {
    // Learn mode posts a transactionId. The duplicate creating nothing must not
    // cost the user the connection they were making.
    const bytes = "%PDF-1.4 a second invoice";
    connects.length = 0;

    const first = (await (await post(upload(bytes))).json()) as { fileId: string };
    const second = (await (
      await post(upload(bytes, { transactionId: "tx-1" }))
    ).json()) as { fileId: string; duplicate: boolean };

    expect(second).toMatchObject({ fileId: first.fileId, duplicate: true });
    expect(connects).toEqual([
      {
        name: "connectFileToTransaction",
        data: expect.objectContaining({ fileId: first.fileId, transactionId: "tx-1", origin: "manual" }),
        token: `Bearer ${USER}`,
      },
    ]);
  });

  it("writes no File Connection itself, so the File keeps the ones it had", async () => {
    // The connect adds a pair; it never replaces the File's list, which the
    // route used to rewrite from what it had read.
    const bytes = "%PDF-1.4 one invoice, two transactions";
    store.seed("transactions", "tx-1", { userId: USER, fileIds: [] });

    const first = (await (
      await post(upload(bytes, { transactionId: "tx-1" }))
    ).json()) as { fileId: string };

    const file = await store.collection("files").doc(first.fileId).get();
    expect(file.data()?.transactionIds).toEqual([]);
    const tx = await store.collection("transactions").doc("tx-1").get();
    expect(tx.data()?.fileIds).toEqual([]);
  });

  it("keeps another user's identical bytes apart", async () => {
    const bytes = "%PDF-1.4 one invoice";

    const mine = (await (await post(upload(bytes))).json()) as { fileId: string };
    const theirs = (await (
      await post(upload(bytes, {}, "rechnung.pdf", "user-2"))
    ).json()) as { fileId: string; duplicate: boolean };

    expect(theirs.duplicate).toBe(false);
    expect(theirs.fileId).not.toBe(mine.fileId);
  });
});
