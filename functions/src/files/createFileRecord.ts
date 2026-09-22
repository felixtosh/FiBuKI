/**
 * The one place a File record is written.
 *
 * Every ingestion path used to run the duplicate check itself, in its own copy,
 * immediately before its own `files.add(...)`. Five copies of the same four
 * lines — and MCP `upload_file` with no copy at all, which is why it wrote
 * records carrying no `contentHash` for anything to compare against afterwards
 * (#182). A guard every path has to remember to bring is a guard the sixth
 * path forgets.
 *
 * So the check lives here, at the write: a path inherits it by writing at all,
 * and a record with no hash is refused rather than stored. The hash is the only
 * thing that makes a File recognisable as a copy later, so it is mandatory
 * where it can still be supplied — not optional at the exact point it could be
 * required.
 *
 * Byte-level only. Same bytes, same hash, same File; two different scans of one
 * invoice are two documents here, and telling those apart is #162.
 */

export const FILES_COLLECTION = "files";

export interface CreateFileRecordResult {
  /** The new File, or the existing one when these bytes were already on file. */
  fileId: string;
  /** True when nothing was written because the bytes were already on file. */
  duplicate: boolean;
}

/**
 * A write that carries no content hash. Separate from a generic Error so the
 * callable can map it onto `invalid-argument` without matching on message text.
 */
export class MissingContentHashError extends Error {
  constructor() {
    super(
      "contentHash is required — a File written without one can never be recognised as a copy"
    );
    this.name = "MissingContentHashError";
  }
}

/**
 * The user's File carrying these bytes, if there is one.
 *
 * Deliberately includes soft-deleted Files: a deleted File is still a record of
 * the document, and re-creating it would leave the user with the copy they
 * deleted plus a new one. This is the lookup `createFileRecord` performs, and
 * it is exported so a path that wants to avoid uploading bytes it already has
 * can ask the same question ahead of the upload — the same function, not
 * another copy of it.
 */
export async function findFileByContentHash(
  db: FirebaseFirestore.Firestore,
  userId: string,
  contentHash: string
): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const snapshot = await db
    .collection(FILES_COLLECTION)
    .where("userId", "==", userId)
    .where("contentHash", "==", contentHash)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0];
}

/**
 * Write a File record, unless its bytes are already on file.
 *
 * `record` is the document as the calling path builds it — this is the write
 * itself, not a field mapper, so each path keeps its own source fields. It must
 * carry `userId` and `contentHash`.
 */
export async function createFileRecord(
  db: FirebaseFirestore.Firestore,
  record: Record<string, unknown>
): Promise<CreateFileRecordResult> {
  const userId = record.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("userId is required");
  }

  const contentHash = record.contentHash;
  if (typeof contentHash !== "string" || !contentHash) {
    throw new MissingContentHashError();
  }

  const existing = await findFileByContentHash(db, userId, contentHash);
  if (existing) {
    return { fileId: existing.id, duplicate: true };
  }

  const docRef = await db.collection(FILES_COLLECTION).add(record);
  return { fileId: docRef.id, duplicate: false };
}
