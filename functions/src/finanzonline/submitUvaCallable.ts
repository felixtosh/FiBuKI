/**
 * Cloud Function: Submit UVA to FinanzOnline
 *
 * Handles the complete UVA submission flow:
 * 1. Load & decrypt credentials
 * 2. Generate UVA XML
 * 3. SOAP: Session login
 * 4. SOAP: File upload
 * 5. SOAP: Session logout
 * 6. Store submission record
 */

import { defineSecret } from "firebase-functions/params";
import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { decrypt } from "../utils/encryption";
import { sha256 } from "../utils/encryption";
import { sessionLogin, sessionLogout, uploadFile, isSuccess, getErrorMessage } from "./soapClient";
import { generateUvaXml } from "../reports/generateUvaXml";
import type {
  SubmitUvaRequest,
  SubmitUvaResponse,
  FinanzOnlineCredentialsDocument,
} from "../types/finanzonline";

// ============================================================================
// Secrets
// ============================================================================

const FINANZONLINE_ENCRYPTION_KEY = defineSecret("FINANZONLINE_ENCRYPTION_KEY");

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Set to 'T' for test environment, 'P' for production
 * Can be configured via environment variable
 */
const SUBMISSION_MODE: "P" | "T" = (process.env.FINANZONLINE_MODE as "P" | "T") || "T";

// ============================================================================
// Submit UVA Callable
// ============================================================================

export const submitUvaToFinanzOnlineCallable = createCallable<
  SubmitUvaRequest,
  SubmitUvaResponse
>(
  {
    name: "submitUvaToFinanzOnline",
    secrets: [FINANZONLINE_ENCRYPTION_KEY],
    timeoutSeconds: 60, // SOAP calls can be slow
    memory: "512MiB",
  },
  async (ctx, request) => {
    // Admin-only while feature is being hardened
    const isAdmin = ctx.request.auth?.token?.admin === true;
    if (!isAdmin) {
      throw new HttpsError(
        "permission-denied",
        "FinanzOnline integration is currently admin-only"
      );
    }

    const { kennzahlen, period, taxNumber } = request;

    // ========================================================================
    // Validate inputs
    // ========================================================================

    if (!taxNumber || !/^\d{9}$/.test(taxNumber)) {
      throw new HttpsError(
        "invalid-argument",
        "Tax number (FASTNR) must be exactly 9 digits"
      );
    }

    if (!kennzahlen || typeof kennzahlen !== "object") {
      throw new HttpsError("invalid-argument", "kennzahlen record is required");
    }

    if (!period) {
      throw new HttpsError("invalid-argument", "Period is required");
    }

    // ========================================================================
    // Load credentials
    // ========================================================================

    const credentialsDoc = await ctx.db
      .collection("finanzonlineCredentials")
      .doc(ctx.userId)
      .get();

    if (!credentialsDoc.exists) {
      throw new HttpsError(
        "failed-precondition",
        "FinanzOnline credentials not configured. Please set up your credentials in Settings > Integrations."
      );
    }

    const credentials = credentialsDoc.data() as FinanzOnlineCredentialsDocument;

    // Get encryption key
    const encryptionKey = FINANZONLINE_ENCRYPTION_KEY.value();
    if (!encryptionKey || encryptionKey.length !== 64) {
      throw new HttpsError(
        "failed-precondition",
        "FinanzOnline encryption not configured"
      );
    }

    // Decrypt PIN
    let pin: string;
    try {
      pin = decrypt(credentials.encryptedPin, credentials.iv, encryptionKey);
    } catch (error) {
      console.error("[FinanzOnline] Failed to decrypt PIN:", error);
      throw new HttpsError(
        "internal",
        "Failed to decrypt credentials. Please re-save your credentials."
      );
    }

    // ========================================================================
    // Generate XML
    // ========================================================================

    console.log(
      `[FinanzOnline] Generating UVA XML for ${period.year}-${period.period} (${period.type})`
    );

    const xml = generateUvaXml(kennzahlen, period, taxNumber);
    const xmlHash = sha256(xml);

    // ========================================================================
    // Create submission record (pending)
    // ========================================================================

    const submissionRef = ctx.db.collection("finanzonlineSubmissions").doc();
    const submissionId = submissionRef.id;

    await submissionRef.set({
      id: submissionId,
      userId: ctx.userId,
      periodYear: period.year,
      periodNumber: period.period,
      periodType: period.type,
      taxNumber,
      xmlHash,
      status: "pending",
      submittedAt: FieldValue.serverTimestamp(),
    });

    // ========================================================================
    // SOAP: Login
    // ========================================================================

    let sessionId: string | null = null;

    try {
      console.log(`[FinanzOnline] Logging in...`);

      const loginResult = await sessionLogin({
        teilnehmerId: credentials.teilnehmerId,
        benutzerId: credentials.benutzerId,
        pin,
      });

      if (!isSuccess(loginResult.returnCode) || !loginResult.sessionId) {
        const errorMsg = loginResult.message || getErrorMessage(loginResult.returnCode);

        await submissionRef.update({
          status: "failed",
          errorMessage: `Login failed: ${errorMsg}`,
        });

        throw new HttpsError("unauthenticated", `FinanzOnline login failed: ${errorMsg}`);
      }

      sessionId = loginResult.sessionId;
      console.log(`[FinanzOnline] Login successful`);

      // ======================================================================
      // SOAP: Upload
      // ======================================================================

      console.log(`[FinanzOnline] Uploading UVA (mode: ${SUBMISSION_MODE})...`);

      const uploadResult = await uploadFile({
        sessionId,
        teilnehmerId: credentials.teilnehmerId,
        benutzerId: credentials.benutzerId,
        art: "U30", // UVA declaration type
        uebermittlung: SUBMISSION_MODE,
        xmlData: xml,
      });

      if (!isSuccess(uploadResult.returnCode)) {
        const errorMsg = uploadResult.message || getErrorMessage(uploadResult.returnCode);

        await submissionRef.update({
          status: "failed",
          errorMessage: `Upload failed: ${errorMsg}`,
        });

        throw new HttpsError("internal", `FinanzOnline upload failed: ${errorMsg}`);
      }

      // ======================================================================
      // Success!
      // ======================================================================

      const referenceNumber = uploadResult.referenceNumber || undefined;

      console.log(
        `[FinanzOnline] Upload successful! Reference: ${referenceNumber || "none"}`
      );

      // Update submission record
      await submissionRef.update({
        status: "success",
        referenceNumber: referenceNumber || null,
      });

      // Update last submission timestamp in userData
      await ctx.db
        .collection("users")
        .doc(ctx.userId)
        .collection("settings")
        .doc("userData")
        .set(
          {
            finanzonline: {
              lastSubmissionAt: FieldValue.serverTimestamp(),
            },
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      return {
        success: true,
        referenceNumber,
        submissionId,
      };
    } catch (error) {
      // Ensure we logout on any error
      if (sessionId) {
        await sessionLogout(
          sessionId,
          credentials.teilnehmerId,
          credentials.benutzerId
        ).catch(() => {});
      }

      // Re-throw HttpsError as-is
      if (error instanceof HttpsError) {
        throw error;
      }

      // Update submission record with error
      await submissionRef.update({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });

      console.error("[FinanzOnline] Submission error:", error);
      throw new HttpsError(
        "internal",
        error instanceof Error ? error.message : "FinanzOnline submission failed"
      );
    } finally {
      // Always try to logout
      if (sessionId) {
        await sessionLogout(
          sessionId,
          credentials.teilnehmerId,
          credentials.benutzerId
        ).catch(() => {});
      }
    }
  }
);
