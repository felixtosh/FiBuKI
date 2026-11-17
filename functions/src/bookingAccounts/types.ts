/**
 * A Booking Account (Sachkonto, #785): the account a File's or Transaction's
 * amount is booked to, in the Austrian chart, plus what another bookkeeping
 * tool recorded about it. Stored as a list beside the Extraction, never inside
 * it: a re-extraction leaves it alone and setting it is not a Hand Correction.
 *
 * The web app imports this file, so it has no runtime import.
 */

/** Where the value came from. `manual` is reserved for a User-facing editor. */
export const BOOKING_ACCOUNT_ORIGINS = ["sevdesk", "manual"] as const;
export type BookingAccountOrigin = (typeof BOOKING_ACCOUNT_ORIGINS)[number];

export interface BookingAccount {
  /** Number in the Austrian chart; a string, a chart may carry leading zeros. */
  accountNumber: string;
  accountName: string;
  /** Numbers in the German charts, when the source tool knew them. */
  skr03: string | null;
  skr04: string | null;
  /** Booked as a fixed asset (Anlagevermögen). */
  isAsset: boolean;
  /** Booked as a low-value asset (GWG). */
  isGwg: boolean;
  /** The rate group this entry belongs to, 0-100; null when it covers the whole item. */
  vatPercent: number | null;
  /** Gross cents booked to this account; null when it covers the whole item. */
  amount: number | null;
  origin: BookingAccountOrigin;
  /** The source tool's own id for the account, e.g. SevDesk's accounting type. */
  externalId: string | null;
}
