import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// One copy, shared with the backend (#689); browser-safe and import-free.
export { toDateSafe } from "@/functions/src/utils/toDateSafe";

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

/** A byte count as B, KB or MB with one decimal. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
