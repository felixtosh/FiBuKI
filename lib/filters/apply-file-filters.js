/**
 * @param {import("./apply-file-filters").RawTaxFile[]} rawFiles
 * @param {import("./apply-file-filters").FileFilterInput} filters
 * @returns {import("./apply-file-filters").FileFilterResult}
 */
function applyFileFilters(rawFiles, filters = {}) {
  const {
    includeDeleted,
    search,
    hasConnections,
    extractionComplete,
    isNotInvoice,
    extractedDateFrom,
    extractedDateTo,
    partnerIds,
    hasPartner,
    amountType,
  } = filters;

  let rows = rawFiles;

  if (!includeDeleted) {
    rows = rows.filter((f) => !f.deletedAt);
  }

  if (search) {
    const searchLower = search.toLowerCase();
    rows = rows.filter(
      (f) =>
        f.fileName.toLowerCase().includes(searchLower) ||
        (f.extractedPartner?.toLowerCase() || "").includes(searchLower),
    );
  }

  if (hasConnections !== undefined) {
    rows = rows.filter((f) =>
      hasConnections
        ? f.transactionIds.length > 0
        : f.transactionIds.length === 0,
    );
  }

  if (extractionComplete !== undefined) {
    rows = rows.filter((f) => f.extractionComplete === extractionComplete);
  }

  if (isNotInvoice !== undefined) {
    rows = rows.filter((f) =>
      isNotInvoice ? f.isNotInvoice === true : f.isNotInvoice !== true,
    );
  }

  if (extractedDateFrom || extractedDateTo) {
    rows = rows.filter((f) => {
      if (!f.extractedDate) return false;
      const fileDate = f.extractedDate.toDate();
      if (extractedDateFrom && fileDate < extractedDateFrom) return false;
      if (extractedDateTo) {
        // Add 1 day to include the end date fully
        const endDate = new Date(extractedDateTo);
        endDate.setDate(endDate.getDate() + 1);
        if (fileDate >= endDate) return false;
      }
      return true;
    });
  }

  if (partnerIds && partnerIds.length > 0) {
    const partnerIdSet = new Set(partnerIds);
    rows = rows.filter((f) => f.partnerId && partnerIdSet.has(f.partnerId));
  } else if (hasPartner !== undefined) {
    // Only reachable when no specific partners are picked: naming partners is
    // the narrower ask, so it wins over the has/has-no state.
    rows = rows.filter((f) => (hasPartner ? !!f.partnerId : !f.partnerId));
  }

  if (amountType && amountType !== "all") {
    rows = rows.filter((f) => {
      if (!f.invoiceDirection) return false;
      if (amountType === "expense") return f.invoiceDirection === "incoming";
      if (amountType === "income") return f.invoiceDirection === "outgoing";
      return true;
    });
  }

  const invoiceCount = rows.filter((f) => f.isNotInvoice !== true).length;

  return { rows, invoiceCount };
}

module.exports = { applyFileFilters };
