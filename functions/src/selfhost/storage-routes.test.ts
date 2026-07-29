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

  it("getDownloadURL returns a /__storage/download/... URL with ?token=, and a raw fetch streams the bytes", async () => {
    const storage = getStorage();
    const r = ref(storage, "receipts/u1/dl.txt");
    const payload = Buffer.from("download me", "utf-8");
    await uploadBytes(r, payload, { contentType: "text/plain" });

    const url = await getDownloadURL(r);
    expect(url).toContain("/__storage/download/receipts/u1/dl.txt");
    expect(url).toContain("token=");

    const res = await fetch(url);
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
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
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
