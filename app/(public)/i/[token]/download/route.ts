/**
 * Public invoice PDF download route.
 *
 * GET /i/{token}/download
 *
 * An unauthenticated visitor holding a valid share token can download the
 * stored invoice PDF. The share page (`../page.tsx`) previously pointed the
 * "PDF herunterladen" button straight at `file.downloadUrl`, which for the
 * self-host backend is a `/__storage/download/<path>` route that REQUIRES a
 * Bearer token (or `?token=`) — an anonymous visitor has neither, so the
 * download 401'd with UNAUTHENTICATED.
 *
 * This route does the auth itself, the same way page.tsx does: it verifies the
 * `invoiceShares/{token}` doc via the Admin SDK (server-only, bypasses the
 * Firestore rules that deny client reads), resolves the invoice's stored PDF
 * file, reads the bytes server-side with admin Storage, and streams them back.
 * The privileged selfhost storage route is never loosened and no Bearer token
 * is ever exposed to the client.
 *
 * Security mirrors the share page exactly:
 * - Unknown / short token            -> 404
 * - Missing / revoked share doc      -> 404
 * - Missing invoice                  -> 404
 * - Cancelled invoice                -> 404
 * - Invoice without a rendered PDF   -> 404
 * - Stored object unreadable         -> 404
 *
 * Every 404 carries the same body so a visitor cannot tell which check failed.
 * The server log can: each branch logs its own reason (never the full token),
 * which is what was missing when #372 had to be diagnosed from the outside.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

import { getAdminDb, getAdminBucket } from "@/lib/firebase/admin";
import { Invoice, InvoiceShare } from "@/types/invoice";
import { TaxFile } from "@/types/file";

interface RouteParams {
  params: Promise<{ token: string }>;
}

/**
 * A fresh 404 per call. A Response body can be consumed once, so one shared
 * module-level instance is not safe to hand to more than one request.
 */
function notFound(reason: string, token?: string, err?: unknown): NextResponse {
  const tokenHint = token ? `${token.slice(0, 6)}…` : "(none)";
  if (err !== undefined) {
    console.error(`[i/download] 404 ${reason} token=${tokenHint}:`, err);
  } else {
    console.warn(`[i/download] 404 ${reason} token=${tokenHint}`);
  }
  return new NextResponse("Not found", { status: 404 });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  if (!token || token.length < 16) return notFound("malformed-token");

  const db = getAdminDb();

  const shareSnap = await db.collection("invoiceShares").doc(token).get();
  if (!shareSnap.exists) return notFound("share-missing", token);
  const share = shareSnap.data() as InvoiceShare | undefined;
  if (!share || share.revokedAt) return notFound("share-revoked", token);

  const invoiceSnap = await db.collection("invoices").doc(share.invoiceId).get();
  if (!invoiceSnap.exists) return notFound("invoice-missing", token);
  const invoice = {
    id: invoiceSnap.id,
    ...(invoiceSnap.data() as Omit<Invoice, "id">),
  } as Invoice;
  if (invoice.status === "cancelled") return notFound("invoice-cancelled", token);
  if (!invoice.fileId) return notFound("invoice-without-file", token);

  const fileSnap = await db.collection("files").doc(invoice.fileId).get();
  if (!fileSnap.exists) return notFound("file-missing", token);
  const file = fileSnap.data() as TaxFile | undefined;
  const storagePath = file?.storagePath;
  if (!file || !storagePath) return notFound("file-without-storage-path", token);

  try {
    const [data] = await getAdminBucket().file(storagePath).download();
    const bytes = new Uint8Array(data);

    // Prefer the invoice's composed number for the saved filename; fall back to
    // the stored file name. RFC 5987 encoding covers non-ASCII (umlauts).
    const baseName =
      file.fileName ||
      (invoice.number ? `Rechnung-${invoice.number}` : "Rechnung");
    const withExt = baseName.toLowerCase().endsWith(".pdf")
      ? baseName
      : `${baseName}.pdf`;
    const asciiName = withExt.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    const encodedName = encodeURIComponent(withExt);

    return new NextResponse(bytes, {
      headers: {
        "Content-Type": file.fileType || "application/pdf",
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    // Covers both "object absent" and "blob store unreachable or unconfigured".
    // The latter is what #372 was: fibuki-web had no storage configuration, so
    // every read threw here and looked exactly like a missing share.
    return notFound("storage-read-failed", token, err);
  }
}
