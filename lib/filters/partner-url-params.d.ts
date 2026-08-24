import type { PartnerFilters } from "@/types/partner";

export type { PartnerFilters };

export function parsePartnerFiltersFromUrl(
  searchParams: URLSearchParams,
): PartnerFilters;

export function buildPartnerSearchParams(
  filters: PartnerFilters,
  search: string,
  selectedId?: string | null,
): URLSearchParams;

export function buildPartnerFilterUrl(
  filters: PartnerFilters,
  search?: string,
  selectedId?: string | null,
): string;

export function hasActivePartnerFilters(filters: PartnerFilters): boolean;
