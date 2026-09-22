/**
 * Pure selection-toggle logic for the Files page checkbox column. Kept
 * independent of React/Firestore so it can be unit tested directly.
 *
 * The "primary" selection (?id= in the URL) always drives the detail panel
 * and is always implicitly part of the combined selection. Toggling a row's
 * own checkbox back off closes the panel (there's no other way to represent
 * "primary row, unchecked"); every other toggle only touches the additional
 * (bulk) selection set and leaves the panel alone.
 *
 * @param {import("./bulk-file-selection").ToggleFileCheckboxInput} input
 * @returns {import("./bulk-file-selection").ToggleResult}
 */
function toggleFileCheckbox({ fileId, checked, primarySelectedId, additionalSelectedIds }) {
  const nextAdditional = new Set(additionalSelectedIds);

  if (checked) {
    if (fileId !== primarySelectedId) {
      nextAdditional.add(fileId);
    }
    return { additionalSelectedIds: nextAdditional, closePrimary: false };
  }

  if (fileId === primarySelectedId) {
    return { additionalSelectedIds: nextAdditional, closePrimary: true };
  }

  nextAdditional.delete(fileId);
  return { additionalSelectedIds: nextAdditional, closePrimary: false };
}

/**
 * @param {import("./bulk-file-selection").ToggleSelectAllInput} input
 * @returns {import("./bulk-file-selection").ToggleResult}
 */
function toggleSelectAll({ displayedFileIds, primarySelectedId, additionalSelectedIds }) {
  const selected = new Set(additionalSelectedIds);
  if (primarySelectedId) selected.add(primarySelectedId);

  const allSelected =
    displayedFileIds.length > 0 && displayedFileIds.every((id) => selected.has(id));

  const nextAdditional = new Set(additionalSelectedIds);

  if (allSelected) {
    displayedFileIds.forEach((id) => nextAdditional.delete(id));
    const closePrimary =
      Boolean(primarySelectedId) && displayedFileIds.includes(primarySelectedId);
    return { additionalSelectedIds: nextAdditional, closePrimary };
  }

  displayedFileIds.forEach((id) => {
    if (id !== primarySelectedId) nextAdditional.add(id);
  });
  return { additionalSelectedIds: nextAdditional, closePrimary: false };
}

/**
 * @param {import("./bulk-file-selection").GetSelectAllCheckedStateInput} input
 * @returns {import("./bulk-file-selection").SelectAllCheckedState}
 */
function getSelectAllCheckedState({ displayedFileIds, selectedIds }) {
  if (displayedFileIds.length === 0) return "unchecked";
  const selectedCount = displayedFileIds.filter((id) => selectedIds.has(id)).length;
  if (selectedCount === 0) return "unchecked";
  if (selectedCount === displayedFileIds.length) return "checked";
  return "indeterminate";
}

/**
 * Resolves the table's row-click/modifier-click selection Set into what the
 * primary (URL) selection and the additional (bulk) selection should become.
 *
 * Only a plain click (no modifier) collapses the selection down to a single
 * primary row. A ctrl/cmd-click or shift-click reports through the same Set,
 * so a resulting Set of size 1 (e.g. deselecting down to one row, or the
 * first modifier-click from an empty selection) must NOT be mistaken for a
 * plain click - that mistake is what turned modifier-click selection into
 * radio-button behaviour: every click after the first cleared the rest.
 *
 * @param {import("./bulk-file-selection").ResolveSelectionChangeInput} input
 * @returns {import("./bulk-file-selection").SelectionChangeResult}
 */
function resolveSelectionChange({
  newSelectedIds,
  isPlainClick,
  primarySelectedId,
  clickedRowId,
  isRangeClick,
}) {
  if (isPlainClick) {
    const [id] = newSelectedIds;
    return { primaryId: id ?? null, additionalSelectedIds: new Set() };
  }

  if (newSelectedIds.size === 0) {
    return { primaryId: null, additionalSelectedIds: new Set() };
  }

  // #232 review follow-up: a modified click can move the primary (panel)
  // selection. Shift-click promotes the end of the range it just drew, and a
  // ctrl/cmd-click made with no panel open opens one on the row it added —
  // both are the behaviour the page had before the selection rewrite, and
  // both were lost when every modified click started preserving the primary.
  // A ctrl/cmd-click that DESELECTS a row promotes nothing: the clicked row
  // is no longer in the set, so there is nothing to show.
  let primaryId = primarySelectedId;
  const promotable = clickedRowId && newSelectedIds.has(clickedRowId);
  if (promotable && (isRangeClick || !primarySelectedId)) {
    primaryId = clickedRowId;
  }

  const nextAdditional = new Set(newSelectedIds);
  if (primaryId) {
    nextAdditional.delete(primaryId);
  }
  return { primaryId: primaryId ?? null, additionalSelectedIds: nextAdditional };
}

module.exports = {
  toggleFileCheckbox,
  toggleSelectAll,
  getSelectAllCheckedState,
  resolveSelectionChange,
};
