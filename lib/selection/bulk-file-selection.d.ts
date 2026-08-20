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
