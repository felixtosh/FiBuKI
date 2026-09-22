export interface DroppedFileLike {
  name: string;
  size: number;
  lastModified?: number;
  type?: string;
}

export interface DropReentryGuard {
  /**
   * Claim a dropped batch. Returns a token to release when the batch has
   * settled, or null when this exact drop is already in flight — a second
   * dispatch of one user action.
   */
  claim(files: ReadonlyArray<DroppedFileLike>): string | null;
  /** Release a claim so the same files can be dropped again later. */
  release(token: string | null): void;
}

export function createDropReentryGuard(): DropReentryGuard;

export function dropSignature(files: ReadonlyArray<DroppedFileLike>): string;
