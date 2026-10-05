/**
 * Safely convert various date formats to a Date. The one copy (#689): the
 * frontend reaches it through `@/lib/utils`, which re-exports it. Keep it
 * browser-safe and import-free.
 *
 * Handles: Firestore Timestamp, serialized timestamp {seconds, nanoseconds},
 * Date, ISO string. A value that is present but the wrong shape degrades to
 * `null` instead of throwing or silently landing on the epoch.
 */
export function toDateSafe(value: unknown): Date | null {
  if (!value) return null;
  // Firestore Timestamp with toDate method
  if (typeof value === "object" && "toDate" in value && typeof (value as { toDate: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  // Serialized Firestore Timestamp {seconds, nanoseconds}
  if (typeof value === "object" && "seconds" in value) {
    const ts = value as { seconds: unknown; nanoseconds?: unknown };
    if (typeof ts.seconds !== "number" || !Number.isFinite(ts.seconds)) return null;
    const nanoseconds = typeof ts.nanoseconds === "number" && Number.isFinite(ts.nanoseconds) ? ts.nanoseconds : 0;
    return new Date(ts.seconds * 1000 + nanoseconds / 1000000);
  }
  // Already a Date
  if (value instanceof Date) return value;
  // ISO string or other string format
  if (typeof value === "string") {
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
