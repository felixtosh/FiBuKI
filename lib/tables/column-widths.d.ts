export interface ColumnWidthLimits {
  min: number;
  max: number;
}
export declare function parseColumnWidths(saved: string | null | undefined): Record<string, number>;
export declare function clampColumnWidth(width: number, limits: ColumnWidthLimits): number;
export declare function sizedColumnWidth(
  sizing: Record<string, number>,
  columnId: string,
  limits: ColumnWidthLimits
): number | undefined;
export declare function columnWidthsToStore(
  sizing: Record<string, number>,
  limitsById: Record<string, ColumnWidthLimits>
): string;
export declare function readStoredColumnWidths(
  getStorage: () => Pick<Storage, "getItem">,
  key: string
): string | null;
export declare function writeStoredColumnWidths(
  getStorage: () => Pick<Storage, "setItem">,
  key: string,
  value: string
): void;
