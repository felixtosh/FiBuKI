/**
 * A File's Partner: assigning and removing it (#627).
 *
 * The one server path for both. The File detail panel and the Files list call
 * it through the callables below; MCP's `assign_partner_to_file` and
 * `remove_partner_from_file` and the chat agent call it through `handleTool`.
 * So the same assign or remove writes the same File and Partner records,
 * whoever asked.
 *
 * The File write goes through `updateFileInternal`, the `updateFile` contract:
 * its field whitelist, its check that the Partner is the User's own or a
 * Global Partner, and its cancelling of the Partner worker on a manual assign
 * or an accepted suggestion. On top of that this module keeps the Partner's
 * `manualFileRemovals`: a removal of a system-recommended assignment is
 * recorded there, and a person assigning the pair again clears it.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { updateFileInternal } from "./updateFile";
import { activityEntry, logActivity, type ActivityActor } from "../utils/activity";

type Db = FirebaseFirestore.Firestore;

/**
 * How the assignment came about. `manual`, `suggestion` and `auto` are a
 * person's UI (`auto`: the detail panel applying a high-confidence
 * suggestion); `ai` is the chat agent's (#665).
 */
export type FilePartnerMatchedBy = "manual" | "suggestion" | "auto" | "ai";

export interface AssignPartnerToFileInput {
  /** Who assigned it, for the activity log (#752). Defaults from `matchedBy`; the tool surface passes `ai`. */
  actor?: ActivityActor;
  fileId: string;
  partnerId: string;
  partnerType: "user" | "global";
  matchedBy: FilePartnerMatchedBy;
  /** Written as given, null included; left out, the File keeps its stored confidence. */
  confidence?: number | null;
}

export interface AssignPartnerToFileResult {
  fileId: string;
  partnerId: string;
  partnerName: string | null;
  previousPartnerId: string | null;
}

export interface RemovePartnerFromFileResult {
  fileId: string;
  previousPartnerId: string | null;
  recordedAsFalsePositive: boolean;
}

async function loadOwnFile(db: Db, userId: string, fileId: string) {
  if (!fileId || typeof fileId !== "string" || fileId.includes("/")) {
    throw new HttpsError("invalid-argument", "fileId is required");
  }
  const fileDoc = await db.collection("files").doc(fileId).get();
  if (!fileDoc.exists || fileDoc.data()?.userId !== userId) {
    throw new HttpsError("not-found", "File not found");
  }
  return fileDoc;
}

/**
 * The Partner the File will point at: the User's own and not merged away, or
 * a Global Partner. Another User's Partner answers like a missing one. A
 * Merged Partner is refused naming its survivor, so a caller holding a stale
 * id corrects itself (ADR-0005).
 */
async function loadUsablePartner(
  db: Db,
  userId: string,
  partnerId: string,
  partnerType: "user" | "global"
) {
  if (!partnerId || typeof partnerId !== "string" || partnerId.includes("/")) {
    throw new HttpsError("invalid-argument", "partnerId must be a document id");
  }
  const partnerDoc = await db
    .collection(partnerType === "global" ? "globalPartners" : "partners")
    .doc(partnerId)
    .get();
  if (!partnerDoc.exists || (partnerType === "user" && partnerDoc.data()?.userId !== userId)) {
    throw new HttpsError("not-found", "Partner not found");
  }
  const mergedInto = partnerDoc.data()!.mergedInto as string | undefined;
  if (partnerType === "user" && mergedInto) {
    throw new HttpsError(
      "failed-precondition",
      `Partner ${partnerId} is a Merged Partner (merged into ${mergedInto}); use ${mergedInto} instead`
    );
  }
  return partnerDoc;
}

/**
 * Point a File at a Partner. A person's own decision (`manual`, or an
 * accepted `suggestion`) also clears the pair from the Partner's
 * `manualFileRemovals`: they changed their mind, so it is no longer a false
 * positive. An automatic assignment (`auto`, the detail panel applying a
 * high-confidence suggestion) and the chat agent's (`ai`) leave the list
 * alone: neither overrules a person's earlier rejection of the pair.
 *
 * The Partner write comes after the File write and is not critical: a
 * failure there is logged, never thrown, so the caller is not told an
 * assignment failed that already happened.
 */
export async function assignPartnerToFile(
  db: Db,
  userId: string,
  input: AssignPartnerToFileInput
): Promise<AssignPartnerToFileResult> {
  const { fileId, partnerId, partnerType, matchedBy, confidence, actor } = input;
  const fileDoc = await loadOwnFile(db, userId, fileId);
  const partnerDoc = await loadUsablePartner(db, userId, partnerId, partnerType);

  await updateFileInternal(db, userId, {
    fileId,
    data: {
      partnerId,
      partnerType,
      partnerMatchedBy: matchedBy,
      ...(confidence !== undefined ? { partnerMatchConfidence: confidence } : {}),
    },
  });

  // The log (#752). A re-assign of the same Partner as the User's own is a confirm.
  const name = (partnerDoc.data()!.name as string | undefined) ?? partnerId;
  const confirm = fileDoc.data()!.partnerId === partnerId;
  await fileDoc.ref.update(logActivity(activityEntry({
    type: "partner_assigned",
    actor: actor ?? (matchedBy === "ai" ? "ai" : matchedBy === "auto" ? "auto" : matchedBy === "suggestion" ? "suggestion" : "manual"),
    partnerName: name,
    forPartnerId: partnerId,
    confidence: confidence ?? null,
    summary: confirm ? `Partner "${name}" confirmed` : `Partner "${name}" assigned`,
  })));

  if ((matchedBy === "manual" || matchedBy === "suggestion") && partnerType === "user") {
    const removals = (partnerDoc.data()!.manualFileRemovals || []) as Array<{ fileId?: string }>;
    if (removals.some((r) => r.fileId === fileId)) {
      try {
        await partnerDoc.ref.update({
          manualFileRemovals: removals.filter((r) => r.fileId !== fileId),
          updatedAt: Timestamp.now(),
        });
      } catch (error) {
        console.error(`[filePartner] Failed to clear the removal of file ${fileId} on partner ${partnerId}:`, error);
      }
    }
  }

  return {
    fileId,
    partnerId,
    partnerName: (partnerDoc.data()!.name as string) || null,
    previousPartnerId: (fileDoc.data()!.partnerId as string | undefined) ?? null,
  };
}

/**
 * Clear a File's Partner. A system-recommended assignment (`auto` or
 * `suggestion`) is recorded on the User's Partner's `manualFileRemovals`, so
 * the matcher learns the pair was wrong; any other is simply cleared.
 *
 * Recording it comes after the File write and is not critical: a failure is
 * logged, never thrown, and `recordedAsFalsePositive` stays false.
 */
export async function removePartnerFromFile(
  db: Db,
  userId: string,
  fileId: string,
  /** Who removed it, for the activity log (#752); the tool surface passes `ai`. */
  actor: ActivityActor = "manual"
): Promise<RemovePartnerFromFileResult> {
  const fileDoc = await loadOwnFile(db, userId, fileId);
  const fileData = fileDoc.data()!;
  const previousPartnerId = (fileData.partnerId as string | undefined) ?? null;
  const matchedBy = fileData.partnerMatchedBy as string | undefined;

  await updateFileInternal(db, userId, {
    fileId,
    data: {
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
    },
  });
  if (previousPartnerId) {
    await fileDoc.ref.update(logActivity(activityEntry({
      type: "partner_removed",
      actor,
      forPartnerId: previousPartnerId,
      summary: matchedBy === "auto" || matchedBy === "suggestion" ? "Automatic Partner removed; the matcher learns it was wrong" : "Partner removed",
    })));
  }

  let recordedAsFalsePositive = false;
  if (previousPartnerId && (matchedBy === "auto" || matchedBy === "suggestion")) {
    try {
      const partnerRef = db.collection("partners").doc(previousPartnerId);
      const partnerSnap = await partnerRef.get();
      if (partnerSnap.exists && partnerSnap.data()?.userId === userId) {
        const removals = (partnerSnap.data()!.manualFileRemovals || []) as Array<{ fileId?: string }>;
        if (!removals.some((r) => r.fileId === fileId)) {
          await partnerRef.update({
            manualFileRemovals: FieldValue.arrayUnion({
              fileId,
              removedAt: Timestamp.now(),
              extractedPartner: fileData.extractedPartner || null,
              fileName: fileData.fileName,
            }),
            updatedAt: Timestamp.now(),
          });
        }
        recordedAsFalsePositive = true;
      }
    } catch (error) {
      console.error(`[filePartner] Failed to record the removal of file ${fileId} on partner ${previousPartnerId}:`, error);
    }
  }

  return { fileId, previousPartnerId, recordedAsFalsePositive };
}

// ============================================================================
// Callables: the UI's door
// ============================================================================

interface AssignPartnerToFileRequest {
  fileId: string;
  partnerId: string;
  partnerType: "user" | "global";
  matchedBy: "manual" | "suggestion" | "auto";
  confidence?: number | null;
}

const UI_MATCHED_BY = new Set(["manual", "suggestion", "auto"]);
const ASSIGN_FIELDS = new Set(["fileId", "partnerId", "partnerType", "matchedBy", "confidence"]);

export const assignPartnerToFileCallable = createCallable<
  AssignPartnerToFileRequest,
  { success: boolean } & AssignPartnerToFileResult
>({ name: "assignPartnerToFile" }, async (ctx, request) => {
  const unknown = Object.keys(request ?? {}).filter((key) => !ASSIGN_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new HttpsError("invalid-argument", `assignPartnerToFile does not take ${unknown.join(", ")}`);
  }
  const { fileId, partnerId, partnerType, matchedBy, confidence } = request ?? ({} as AssignPartnerToFileRequest);
  if (partnerType !== "user" && partnerType !== "global") {
    throw new HttpsError("invalid-argument", "partnerType must be user or global");
  }
  if (!UI_MATCHED_BY.has(matchedBy)) {
    throw new HttpsError("invalid-argument", "matchedBy must be manual, suggestion or auto");
  }
  if (
    confidence !== undefined &&
    confidence !== null &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100)
  ) {
    throw new HttpsError("invalid-argument", "confidence must be a number from 0 to 100");
  }
  const result = await assignPartnerToFile(ctx.db, ctx.userId, {
    fileId,
    partnerId,
    partnerType,
    matchedBy,
    confidence: confidence ?? null,
  });
  return { success: true, ...result };
});

export const removePartnerFromFileCallable = createCallable<
  { fileId: string },
  { success: boolean } & RemovePartnerFromFileResult
>({ name: "removePartnerFromFile" }, async (ctx, request) => {
  const unknown = Object.keys(request ?? {}).filter((key) => key !== "fileId");
  if (unknown.length > 0) {
    throw new HttpsError("invalid-argument", `removePartnerFromFile does not take ${unknown.join(", ")}`);
  }
  const result = await removePartnerFromFile(ctx.db, ctx.userId, request?.fileId);
  return { success: true, ...result };
});
