/**
 * Work item 6, slice C — client firebase/storage shim, driven end-to-end
 * against the real storage-routes server (backed by the memory blob store),
 * over a socket, the same harness shape as firestore-client.test.ts /
 * functions-client.test.ts.
 *
 * Proves the shim's job: translate uploadBytes/uploadBytesResumable/
 * getDownloadURL/getBytes/deleteObject into /__storage/{upload,download,
 * object} calls, round-trip raw bytes, drive real upload progress events,
 * and map server errors to FirebaseError-shaped storage/* codes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createStorageRoutes } from "./storage-routes";
import { _resetStorageForTests } from "./storage-shim";
import {
  __configureStorageClient,
  getStorage,
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  getBytes,
  deleteObject,
} from "../../../lib/selfhost/storage-client";

const GOOD_TOKEN = "tok-stefan";

let server: http.Server;
let base: string;

beforeAll(async () => {
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests();

  const app = express();
  app.use(
    "/__storage",
    createStorageRoutes(async (token) => (token === GOOD_TOKEN ? { uid: "stefan-test", token: {} } : null)),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __configureStorageClient({ apiUrl: base, getToken: () => GOOD_TOKEN });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  // Fresh in-process blob store per test — cheap, avoids cross-test bleed.
  _resetStorageForTests();
  __configureStorageClient({ apiUrl: base, getToken: () => GOOD_TOKEN });
});

describe("storage-routes + storage-client", () => {
  it("uploadBytes round-trips a Buffer and a Uint8Array; getBytes returns identical bytes", async () => {
    const storage = getStorage();

    const bufRef = ref(storage, "receipts/u1/buf.bin");
    const payload = Buffer.from("hello fibuki", "utf-8");
    await uploadBytes(bufRef, payload, { contentType: "application/octet-stream" });
    const gotBuf = Buffer.from(await getBytes(bufRef));
    expect(gotBuf.equals(payload)).toBe(true);

    const u8Ref = ref(storage, "receipts/u1/u8.bin");
    const u8 = new Uint8Array([1, 2, 3, 4, 5]);
    await uploadBytes(u8Ref, u8, { customMetadata: { kind: "test" } });
    const gotU8 = new Uint8Array(await getBytes(u8Ref));
    expect(gotU8).toEqual(u8);
  });

  it("getDownloadURL returns a TOKEN-FREE /__storage/download/... URL, streamable with a bearer header", async () => {
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/dl.txt");
    const payload = Buffer.from("download me", "utf-8");
    await uploadBytes(r, payload, { contentType: "text/plain" });

    const url = await getDownloadURL(r);
    expect(url).toContain("/__storage/download/receipts/u1/dl.txt");
    // Security property, pinned deliberately: every caller of getDownloadURL
    // persists its result into a Firestore document, so a token in the URL would
    // be a bearer credential written to the database and copied into every
    // backup. It would also expire, breaking a stored URL about an hour after
    // upload. Rendering uses an Authorization header instead
    // (hooks/use-file-object-url.ts).
    expect(url).not.toContain("token=");

    // Unauthenticated fetch must be refused...
    const anon = await fetch(url);
    expect(anon.status).toBe(401);

    // ...and the header is what grants access.
    const res = await fetch(url, { headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("download me");
  });

  it("uploadBytesResumable fires >=1 progress event and resolves; snapshot.ref feeds getDownloadURL", async () => {
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/resumable.bin");
    const payload = new Uint8Array(1000).fill(7);

    const task = uploadBytesResumable(r, payload);
    const progressEvents: number[] = [];
    let completed = false;

    task.on(
      "state_changed",
      (snap) => progressEvents.push(snap.bytesTransferred),
      undefined,
      () => {
        completed = true;
      },
    );

    const finalSnapshot = await task;

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(completed).toBe(true);
    expect(finalSnapshot.state).toBe("success");
    expect(task.snapshot.state).toBe("success");

    const url = await getDownloadURL(task.snapshot.ref);
    const res = await fetch(url, { headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
    expect(res.ok).toBe(true);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
  });

  it("#135: a throwing progress listener does not fail a delivered upload", async () => {
    // The bytes are in the store and the server returned 2xx. A consumer
    // callback that throws — an unmounted component, a formatting TypeError —
    // used to land in the upload's own catch and be reported as
    // storage/unknown, with `await task` rejecting on a successful upload.
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/throwing-listener.bin");
    const payload = Buffer.from("delivered");

    const task = uploadBytesResumable(r, payload);
    let completed = false;
    let errored: unknown = null;

    task.on(
      "state_changed",
      () => {
        throw new TypeError("listener blew up");
      },
      (err) => {
        errored = err;
      },
      () => {
        completed = true;
      },
    );

    const snapshot = await task;

    expect(snapshot.state).toBe("success");
    expect(errored).toBeNull();
    // A later listener still runs — one bad callback does not swallow the rest.
    expect(completed).toBe(true);
    // And the bytes really are there.
    expect(Buffer.from(await getBytes(r))).toEqual(payload);
  });

  it("#135: a throwing complete listener does not un-resolve the task", async () => {
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/throwing-complete.bin");

    const task = uploadBytesResumable(r, Buffer.from("also delivered"));
    let errored: unknown = null;
    task.on("state_changed", undefined, (err) => {
      errored = err;
    }, () => {
      throw new Error("complete handler blew up");
    });

    await expect(task).resolves.toMatchObject({ state: "success" });
    expect(errored).toBeNull();
    expect(task.snapshot.state).toBe("success");
  });

  it("deleteObject then getBytes rejects with storage/object-not-found", async () => {
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/todelete.bin");
    await uploadBytes(r, Buffer.from("bye"));
    await deleteObject(r);

    await expect(getBytes(r)).rejects.toMatchObject({
      code: "storage/object-not-found",
      name: "FirebaseError",
    });

    // delete is idempotent — deleting again must not throw
    await expect(deleteObject(r)).resolves.toBeUndefined();
  });

  it("a bad token maps to storage/unauthorized", async () => {
    __configureStorageClient({ apiUrl: base, getToken: () => "bogus-token" });
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/authcheck.bin");

    await expect(uploadBytes(r, Buffer.from("x"))).rejects.toMatchObject({
      code: "storage/unauthorized",
      name: "FirebaseError",
    });
  });
});
