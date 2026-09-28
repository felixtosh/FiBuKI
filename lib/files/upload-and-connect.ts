/**
 * Upload and connect, in one step (#246).
 *
 * Files dropped on the overlay that finds a File for a Transaction are
 * uploaded and connected immediately, one File Connection each; Extraction
 * runs afterwards. The drop is the user's assertion that these Files belong
 * here, so every File in it is connected rather than only the first.
 *
 * One drop is one undoable action: `unlinkBatch` Unlinks every Connection the
 * drop made and nothing else. The uploaded Files stay in Files; the undo takes
 * the Connections apart, it does not delete documents.
 *
 * The upload and the Connection are injected, so this is the orchestration
 * only: the upload is lib/files/upload-file.ts, the Connection the
 * connectFileToTransaction callable.
 */

import type { UploadResult } from "./upload-file";

export type DroppedFileOutcome =
  /** Uploaded (or already in Files) and connected by this drop. */
  | { name: string; status: "connected"; fileId: string; reusedExisting: boolean }
  /** Already in Files and already on this Transaction: nothing to do, nothing to undo. */
  | { name: string; status: "already-connected"; fileId: string }
  /** Upload or Connection failed. No Connection was made. */
  | { name: string; status: "failed"; error: string };

export async function uploadAndConnectBatch(
  files: File[],
  deps: {
    transactionId: string;
    upload: (file: File) => Promise<UploadResult>;
    connect: (fileId: string) => Promise<unknown>;
  }
): Promise<DroppedFileOutcome[]> {
  return Promise.all(
    files.map(async (file): Promise<DroppedFileOutcome> => {
      let fileId: string;
      let reusedExisting = false;
      try {
        const result = await deps.upload(file);
        if (result.kind === "duplicate") {
          // The same bytes are already a File: connect that one rather than
          // making a second copy of the document.
          if (result.existing.transactionIds?.includes(deps.transactionId)) {
            return { name: file.name, status: "already-connected", fileId: result.existing.id };
          }
          fileId = result.existing.id;
          reusedExisting = true;
        } else {
          fileId = result.fileId;
        }
      } catch (err) {
        return { name: file.name, status: "failed", error: errorText(err, "Upload failed") };
      }

      try {
        await deps.connect(fileId);
      } catch (err) {
        return { name: file.name, status: "failed", error: errorText(err, "Connecting failed") };
      }
      return { name: file.name, status: "connected", fileId, reusedExisting };
    })
  );
}

/** Undo one drop: Unlink exactly the Connections it made. */
export async function unlinkBatch(
  outcomes: DroppedFileOutcome[],
  unlink: (fileId: string) => Promise<unknown>
): Promise<void> {
  const made = outcomes.filter(
    (o): o is Extract<DroppedFileOutcome, { status: "connected" }> => o.status === "connected"
  );
  await Promise.all(made.map((o) => unlink(o.fileId)));
}

/** A rejected drop (wrong type, too large) as an outcome, so it is reported like any failure. */
export function rejectedOutcome(name: string, reason: string): DroppedFileOutcome {
  return { name, status: "failed", error: reason };
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
