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

module.exports = { toggleFileCheckbox, toggleSelectAll, getSelectAllCheckedState };
