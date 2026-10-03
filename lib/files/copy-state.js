/**
 * Which Files are a Copy right now (#162, ADR-0010), from the user's own File
 * list.
 *
 * A File marked as a Copy is one only while its original is live: not deleted,
 * not purged. The mark stays on the File when the original is deleted, so a
 * restore brings the Copy back, and this reads the answer off the list instead
 * of anything stored. The server derives the same answer in copyOps.
 *
 * @param {Array<{ id: string, copyOfFileId?: string | null, deletedAt?: unknown, purgedAt?: unknown }>} files
 *   every File the user holds, deleted ones included, so originals can be found
 * @returns {Map<string, string>} Copy id -> original id
 */
function liveCopies(files) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const out = new Map();
  for (const f of files) {
    if (!f.copyOfFileId) continue;
    const original = byId.get(f.copyOfFileId);
    if (original && !original.deletedAt && !original.purgedAt) out.set(f.id, f.copyOfFileId);
  }
  return out;
}

/**
 * The Copy suggestion a File carries, when the File it names is live.
 *
 * @param {{ copySuggestion?: { originalFileId: string, reason: string } | null }} file
 * @param {Map<string, { deletedAt?: unknown, purgedAt?: unknown }>} byId
 */
function liveCopySuggestion(file, byId) {
  const s = file.copySuggestion;
  if (!s || !s.originalFileId) return null;
  const original = byId.get(s.originalFileId);
  if (!original || original.deletedAt || original.purgedAt) return null;
  return s;
}

module.exports = { liveCopies, liveCopySuggestion };
