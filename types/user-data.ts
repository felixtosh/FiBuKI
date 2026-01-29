import { Timestamp } from "firebase/firestore";

/**
 * User data for classification and extraction prompts.
 * Used to ensure the user doesn't get accidentally marked as the partner for an invoice.
 * Collection: /users/{userId}/settings/userData
 */
/** ISO 3166-1 alpha-2 country codes supported for tax reporting */
export type TaxCountryCode = "AT" | "DE" | "CH";

export interface UserData {
  /** User's full name (e.g., "Felix Häusler") */
  name: string;

  /** User's company name (e.g., "Infinity Vertigo GmbH") */
  companyName: string;

  /**
   * User's tax residence country (ISO 3166-1 alpha-2).
   * Determines which tax forms and reporting formats are available.
   * Default: "AT" (Austria)
   */
  country?: TaxCountryCode;

  /**
   * Aliases to match against (e.g., "Haeusler" for umlauts).
   * These help identify if the user is the invoice issuer vs recipient.
   */
  aliases: string[];

  /**
   * User's own VAT IDs (e.g., ["ATU12345678"]).
   * Used to identify outgoing invoices and prevent matching user's own VAT as partner.
   */
  vatIds: string[];

  /**
   * User's own IBANs (manually added).
   * Note: IBANs from connected bank accounts are inferred automatically.
   */
  ibans: string[];

  /**
   * User's own email addresses (e.g., ["felix@gmail.com", "info@mycompany.de"]).
   * Manually added. Emails from connected integrations are inferred automatically.
   * Used to prevent matching user's own email as partner during file matching.
   * Full email matching prevents false positives with common domains like gmail.com.
   */
  ownEmails?: string[];

  /**
   * User's tax number (Steuernummer/FASTNR).
   * For Austria: 9-digit number without spaces (e.g., "123456789").
   * Required for FinanzOnline XML export.
   */
  taxNumber?: string;

  /**
   * Partner IDs that were marked as "this is my company".
   * Used to show visual indicators and allow easy undo.
   */
  markedAsMe?: string[];

  /** When the user data was last updated */
  updatedAt: Timestamp;

  /** When the user data was created */
  createdAt: Timestamp;
}

/**
 * Form data for creating/updating user data
 */
export interface UserDataFormData {
  name: string;
  companyName: string;
  country?: TaxCountryCode;
  aliases: string[];
  vatIds: string[];
  ibans: string[];
  ownEmails?: string[];
  taxNumber?: string;
  markedAsMe?: string[];
}

/**
 * Invoice direction based on user data analysis
 */
export type InvoiceDirection = "incoming" | "outgoing" | "unknown";
