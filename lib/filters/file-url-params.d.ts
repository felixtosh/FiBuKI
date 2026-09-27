import type { FileFilters, DocumentType } from "@/types/file";

export type { FileFilters };

export const DOCUMENT_TYPE_FILTER_VALUES: readonly DocumentType[];

export function normalizeDocumentTypes(
  types: readonly DocumentType[] | undefined,
): DocumentType[] | undefined;

export function parseFileFiltersFromUrl(
  searchParams: URLSearchParams,
): FileFilters;

export function buildFileSearchParams(
  filters: FileFilters,
  search: string,
  selectedId?: string | null,
): URLSearchParams;

export function buildFileFilterUrl(
  filters: FileFilters,
  search?: string,
  selectedId?: string | null,
): string;

export function hasFileUrlParams(searchParams: URLSearchParams): boolean;

export function hasActiveFileFilters(filters: FileFilters): boolean;

export function countActiveFileFilters(filters: FileFilters): number;
