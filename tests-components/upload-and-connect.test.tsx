/**
 * #246: dropping Files on the connect overlay uploads each and connects it to
 * the Transaction in one step, and the whole drop undoes as one action.
 */

import { describe, expect, it, vi } from "vitest";
import {
  rejectedOutcome,
  unlinkBatch,
  uploadAndConnectBatch,
} from "@/lib/files/upload-and-connect";
import type { TaxFile } from "@/types/file";

const pdf = (name: string) => new File(["%PDF"], name, { type: "application/pdf" });

describe("uploadAndConnectBatch", () => {
  it("uploads one File and connects it without a further click", async () => {
    const connect = vi.fn().mockResolvedValue("conn-1");
    const outcomes = await uploadAndConnectBatch([pdf("a.pdf")], {
      transactionId: "tx",
      upload: async () => ({ kind: "created", fileId: "f-a" }),
      connect,
    });
    expect(connect).toHaveBeenCalledWith("f-a");
    expect(outcomes).toEqual([
      { name: "a.pdf", status: "connected", fileId: "f-a", reusedExisting: false },
    ]);
  });

  it("creates three Connections for three Files", async () => {
    const connect = vi.fn().mockResolvedValue("ok");
    let n = 0;
    const outcomes = await uploadAndConnectBatch([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], {
      transactionId: "tx",
      upload: async () => ({ kind: "created", fileId: `f-${++n}` }),
      connect,
    });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(outcomes.every((o) => o.status === "connected")).toBe(true);
  });

  it("creates no Connection when the upload fails, and says why", async () => {
    const connect = vi.fn();
    const outcomes = await uploadAndConnectBatch([pdf("a.pdf")], {
      transactionId: "tx",
      upload: async () => {
        throw new Error("storage/unauthorized");
      },
      connect,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ name: "a.pdf", status: "failed", error: "storage/unauthorized" }]);
  });

  it("connects the File that already has these bytes instead of uploading a copy", async () => {
    const connect = vi.fn().mockResolvedValue("ok");
    const existing = { id: "f-old", transactionIds: ["other-tx"] } as unknown as TaxFile;
    const outcomes = await uploadAndConnectBatch([pdf("a.pdf")], {
      transactionId: "tx",
      upload: async () => ({ kind: "duplicate", existing }),
      connect,
    });
    expect(connect).toHaveBeenCalledWith("f-old");
    expect(outcomes[0]).toMatchObject({ status: "connected", fileId: "f-old", reusedExisting: true });
  });

  it("does nothing for a File already on this Transaction", async () => {
    const connect = vi.fn();
    const existing = { id: "f-old", transactionIds: ["tx"] } as unknown as TaxFile;
    const outcomes = await uploadAndConnectBatch([pdf("a.pdf")], {
      transactionId: "tx",
      upload: async () => ({ kind: "duplicate", existing }),
      connect,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "already-connected" });
  });
});

describe("unlinkBatch", () => {
  it("undoes exactly the Connections the drop made", async () => {
    const unlink = vi.fn().mockResolvedValue(undefined);
    await unlinkBatch(
      [
        { name: "a.pdf", status: "connected", fileId: "f-a", reusedExisting: false },
        { name: "b.pdf", status: "already-connected", fileId: "f-b" },
        { name: "c.pdf", status: "failed", error: "x" },
        rejectedOutcome("d.exe", "File type not accepted"),
      ],
      unlink
    );
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith("f-a");
  });
});
