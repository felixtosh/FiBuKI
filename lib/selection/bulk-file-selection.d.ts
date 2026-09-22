export interface ToggleFileCheckboxInput {
  fileId: string;
  checked: boolean;
  primarySelectedId: string | null;
  additionalSelectedIds: Set<string>;
}

export interface ToggleResult {
  additionalSelectedIds: Set<string>;
  /** True if this toggle should also clear the primary (URL) selection. */
  closePrimary: boolean;
}

export function toggleFileCheckbox(input: ToggleFileCheckboxInput): ToggleResult;

export interface ToggleSelectAllInput {
  displayedFileIds: string[];
  primarySelectedId: string | null;
  additionalSelectedIds: Set<string>;
}

export function toggleSelectAll(input: ToggleSelectAllInput): ToggleResult;

export type SelectAllCheckedState = "checked" | "unchecked" | "indeterminate";

export interface GetSelectAllCheckedStateInput {
  displayedFileIds: string[];
  selectedIds: Set<string>;
}

export function getSelectAllCheckedState(
  input: GetSelectAllCheckedStateInput,
): SelectAllCheckedState;

export interface ResolveSelectionChangeInput {
  newSelectedIds: Set<string>;
  /** True for a plain (no modifier) row click; false for ctrl/cmd-click or shift-click. */
  isPlainClick: boolean;
  primarySelectedId: string | null;
  /** The row the click landed on, if the caller knows it. */
  clickedRowId?: string;
  /** True for shift-click, which promotes the clicked end of its range. */
  isRangeClick?: boolean;
}

export interface SelectionChangeResult {
  /** The primary (URL) selection to end up with, or null to clear it. */
  primaryId: string | null;
  additionalSelectedIds: Set<string>;
}

export function resolveSelectionChange(
  input: ResolveSelectionChangeInput,
): SelectionChangeResult;
