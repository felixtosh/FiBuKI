export declare function normalizeVatId(value: unknown): string;

export interface VatIdConflictPartner {
  id: string;
  name: string;
  vatId: string;
}

export interface VatIdConflict {
  a: VatIdConflictPartner;
  b: VatIdConflictPartner;
}

export declare function findVatIdConflicts(
  partners: ReadonlyArray<{ id: string; name: string; vatId?: string | null }>,
): VatIdConflict[];

export declare function isEmptyValue(value: unknown): boolean;

export interface FieldGain {
  field: string;
  label: string;
  fromName: string;
}

/** The fields `fieldGains` reads. A wider partner shape (e.g. `UserPartner`) satisfies this structurally. */
export interface MergeGainSource {
  vatId?: string | null;
  website?: string | null;
  address?: unknown;
}

export declare function fieldGains(
  survivor: MergeGainSource,
  losers: ReadonlyArray<MergeGainSource & { name: string }>,
): FieldGain[];

export declare function newEntryCount(
  survivorList: ReadonlyArray<unknown> | null | undefined,
  loserLists: ReadonlyArray<ReadonlyArray<unknown> | null | undefined>,
  normalize: (item: unknown) => string,
): number;
