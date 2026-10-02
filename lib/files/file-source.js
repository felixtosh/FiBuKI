/**
 * Where a File came from, as data. One table maps a File to its source kind,
 * and each kind says how it is worded, iconed and linked, so adding a source
 * (Dropbox, Drive, ...) is one entry here and one icon in the label component,
 * not a new branch in every consumer.
 *
 * Pure on purpose: no React, no i18n. The label component turns `labelKey`
 * into words and `icon` into a lucide icon.
 */

/** @type {Record<string, { icon: string, labelKey: string, mail?: boolean }>} */
const KINDS = {
  gmail: { icon: "mail", labelKey: "gmail", mail: true },
  forwarding: { icon: "mail", labelKey: "forwarding", mail: true },
  invoicing: { icon: "file", labelKey: "invoicing" },
  browser: { icon: "globe", labelKey: "browser" },
  dropbox: { icon: "cloud", labelKey: "dropbox" },
  gdrive: { icon: "cloud", labelKey: "gdrive" },
  upload: { icon: "upload", labelKey: "upload" },
};

/**
 * @param {import("../../types/file").TaxFile} file
 * @returns {import("./file-source").FileSourceKind}
 */
function fileSourceKind(file) {
  const type = file.sourceType;
  if (type && type.startsWith("gmail")) return "gmail";
  if (type && type.startsWith("email_inbound")) return "forwarding";
  if (type === "fibuki_invoice" || file.invoiceId || file.isFibukiGenerated) return "invoicing";
  if (type === "browser") return "browser";
  if (type === "dropbox") return "dropbox";
  if (type === "gdrive") return "gdrive";
  return "upload";
}

/**
 * What the Source cell shows: the kind, its icon, a literal `text` when the
 * File knows a better name than the generic one (the mailbox address, the
 * domain a browser pull came from), else `labelKey` for the translated
 * default, and an in-app `href` when the source has a page of its own.
 *
 * @param {import("../../types/file").TaxFile} file
 * @returns {import("./file-source").FileSourceView}
 */
function fileSourceView(file) {
  const kind = fileSourceKind(file);
  const { icon, labelKey } = KINDS[kind];
  let text = null;
  let href = null;

  if (kind === "gmail") {
    text = file.gmailIntegrationEmail || null;
    href = file.gmailIntegrationId ? `/integrations/${file.gmailIntegrationId}` : null;
  } else if (kind === "forwarding") {
    href = "/integrations/email-inbound";
  } else if (kind === "browser") {
    text = file.sourceDomain || null;
  } else if (kind === "dropbox" || kind === "gdrive") {
    // One page per provider: it lists the connected folders.
    href = `/integrations/${kind}`;
  }

  return { kind, icon, labelKey, text, href, isMail: Boolean(KINDS[kind].mail) };
}

module.exports = { fileSourceKind, fileSourceView };
