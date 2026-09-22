import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely convert various date formats to Date object.
 * Handles: Firestore Timestamp, serialized timestamp {seconds, nanoseconds}, Date, ISO string
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

export function formatCurrency(
  amount: number,
  currency: string = "EUR",
  locale: string = "de-DE"
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount / 100);
}

export function formatDate(date: Date, locale: string = "de-DE"): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Get the color class for an amount (red for negative, green for positive)
 */
export function getAmountColorClass(amount: number): string {
  return amount < 0 ? "text-amount-negative" : "text-amount-positive";
}

/**
 * Format a date with optional time display (if not midnight)
 */
export function formatDateWithTime(
  date: Date,
  options: { dateFormat?: string; timeFormat?: string } = {}
): { date: string; time?: string } {
  const { dateFormat = "MMM d, yyyy", timeFormat = "HH:mm" } = options;
  // Use date-fns format function if available, otherwise use Intl
  const dateStr = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hasTime = hours !== 0 || minutes !== 0;

  const timeStr = hasTime
    ? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`
    : undefined;

  return { date: dateStr, time: timeStr };
}
