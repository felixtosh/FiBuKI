/**
 * Some file/receipt records were written without a stored `fileType` (#248),
 * so it cannot be treated as a required string at runtime despite what the
 * TaxFile/Receipt interfaces declare. `normalizeFileType` is the one guard
 * applied at every call site that used to call `.startsWith` on it directly.
 *
 * `application/octet-stream` is not an arbitrary sentinel — FilePreview
 * already treats it as "trust the file extension instead", with branches for
 * `.pdf` and for image extensions. The fallback the code already trusts is
 * the fallback used here.
 *
 * @param {string | null | undefined} fileType
 * @returns {string}
 */
function normalizeFileType(fileType) {
  return fileType || "application/octet-stream";
}

/**
 * FilePreview's classification: a missing fileType normalises to
 * `application/octet-stream`, which the extension branches below already
 * know how to read.
 *
 * @param {string | null | undefined} fileType
 * @param {string} fileName
 * @returns {import("./file-kind").FileKind}
 */
function classifyPreviewFile(fileType, fileName) {
  const safeFileType = normalizeFileType(fileType);
  const lowerName = fileName.toLowerCase();
  const isPdf =
    safeFileType === "application/pdf" ||
    (safeFileType === "application/octet-stream" && lowerName.endsWith(".pdf"));
  const isImage =
    safeFileType.startsWith("image/") ||
    (safeFileType === "application/octet-stream" &&
      /\.(png|jpe?g|gif|webp)$/.test(lowerName));
  return { fileType: safeFileType, isPdf, isImage };
}

/**
 * Badge label for FilePreview's thumbnail mode.
 *
 * @param {string | null | undefined} fileType
 * @param {string} fileName
 * @returns {string}
 */
function previewFileExtensionLabel(fileType, fileName) {
  const { fileType: safeFileType, isPdf, isImage } = classifyPreviewFile(fileType, fileName);
  const lowerName = fileName.toLowerCase();

  if (isPdf) return "PDF";
  if (isImage) {
    if (safeFileType.startsWith("image/")) {
      const ext = safeFileType.split("/")[1]?.toUpperCase();
      return ext === "JPEG" ? "JPG" : ext;
    }
    if (/\.(png|jpe?g|gif|webp)$/.test(lowerName)) {
      const ext = lowerName.split(".").pop()?.toUpperCase();
      return ext === "JPEG" ? "JPG" : ext || "IMG";
    }
    return "IMG";
  }
  if (safeFileType === "application/octet-stream" && lowerName.endsWith(".pdf")) {
    return "PDF";
  }
  if (safeFileType.startsWith("image/")) {
    const ext = safeFileType.split("/")[1]?.toUpperCase();
    return ext === "JPEG" ? "JPG" : ext;
  }
  return safeFileType.split("/")[1]?.toUpperCase() || "FILE";
}

/**
 * FileViewerOverlay's and ReceiptList's classification: no file-extension
 * fallback, so a missing fileType renders as a generic file instead of
 * guessing — same as it always has for a genuinely unrecognised MIME type.
 *
 * @param {string | null | undefined} fileType
 * @returns {import("./file-kind").FileKind}
 */
function classifyFileStrict(fileType) {
  const safeFileType = normalizeFileType(fileType);
  return {
    fileType: safeFileType,
    isPdf: safeFileType === "application/pdf",
    isImage: safeFileType.startsWith("image/"),
  };
}

module.exports = {
  normalizeFileType,
  classifyPreviewFile,
  previewFileExtensionLabel,
  classifyFileStrict,
};
