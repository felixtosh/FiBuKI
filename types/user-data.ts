import type { Timestamp } from "firebase/firestore";
import { FinanzOnlineConfig } from "./finanzonline";

/**
 * User data for classification and extraction prompts.
 * Used to ensure the user doesn't get accidentally marked as the partner for an invoice.
 * Collection: /users/{userId}/settings/userData
 */

/** ISO 3166-1 alpha-2 country codes supported for tax reporting */
export type TaxCountryCode = "AT" | "DE" | "CH";

/**
 * Postal address used on issued invoices. All parts optional so
 * partial addresses are fine at draft time; UI nudges the user to fill
 * in what they want shown on the PDF.
 */
export interface IdentityEntityAddress {
  street?: string;
  postalCode?: string;
  city?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "AT", "DE". */
  country?: string;
}

/**
 * A single identity entity (person or company)
 * Each entity can have its own name, VAT ID, IBANs, and aliases
 */
export interface IdentityEntity {
  /** Unique identifier */
  id: string;

  /** Entity type - person (freelancer) or company */
  type: "person" | "company";

  /** Display name */
  name: string;

  /** Alternative names/spellings */
  aliases: string[];

  /** VAT ID for this entity */
  vatId?: string;

  /** Bank accounts for this entity */
  ibans: string[];

  /** Postal address shown on issued invoices (sender block). */
  address?: IdentityEntityAddress;

  /** Linked partner ID (created automatically for matching) */
  partnerId?: string;

  /** Order for display (lower = higher in list) */
  order: number;

  /** When entity was created */
  createdAt: Timestamp;
}

export interface UserData {
  /**
   * User's tax residence country (ISO 3166-1 alpha-2).
   * Determines which tax forms and reporting formats are available.
   * Default: "AT" (Austria)
   */
  country?: TaxCountryCode;

  /**
   * User's tax number (Steuernummer/FASTNR).
   * For Austria: 9-digit number without spaces (e.g., "123456789").
   * Required for FinanzOnline XML export.
   */
  taxNumber?: string;

  /**
   * User's own email addresses (e.g., ["felix@gmail.com", "info@mycompany.de"]).
   * Manually added. Emails from connected integrations are inferred automatically.
   * Used to prevent matching user's own email as partner during file matching.
   */
  ownEmails?: string[];

  /**
   * Primary personal identity (freelancer).
   * Always exists, type: "person".
   */
  personalEntity?: IdentityEntity;

  /**
   * Additional company entities.
   * Array of companies the user operates as.
   */
  companies?: IdentityEntity[];

  /**
   * FinanzOnline WebService configuration.
   * For direct UVA submission to Austrian tax authority.
   */
  finanzonline?: FinanzOnlineConfig;

  // ============================================================================
  // DEPRECATED FIELDS - kept for backward compatibility during migration
  // ============================================================================

  /**
   * @deprecated Use personalEntity.name instead
   * User's full name (e.g., "Felix Häusler")
   */
  name?: string;

  /**
   * @deprecated Use companies array instead
   * User's company name (e.g., "Infinity Vertigo GmbH")
   */
  companyName?: string;

  /**
   * @deprecated Aliases are now per-entity
   * Aliases to match against (e.g., "Haeusler" for umlauts).
   */
  aliases?: string[];

  /**
   * @deprecated VAT IDs are now per-entity
   * User's own VAT IDs (e.g., ["ATU12345678"]).
   */
  vatIds?: string[];

  /**
   * @deprecated IBANs are now per-entity
   * User's own IBANs (manually added).
   */
  ibans?: string[];

  /**
   * @deprecated Partners are now linked via entity.partnerId
   * Partner IDs that were marked as "this is my company".
   */
  markedAsMe?: string[];

  /**
   * @deprecated Use entity.partnerId instead
   * Partner IDs that are auto-synced from identity settings.
   */
  identityPartnerIds?: {
    name?: string;
    companyName?: string;
  };

  /** When the user data was last updated */
  updatedAt: Timestamp;

  /** When the user data was created */
  createdAt: Timestamp;
}

/**
 * Form data for creating/updating an identity entity
 */
export interface IdentityEntityFormData {
  id?: string;
  type: "person" | "company";
  name: string;
  aliases: string[];
  vatId?: string;
  ibans: string[];
  address?: IdentityEntityAddress;
  partnerId?: string;
  order?: number;
}

/**
 * Form data for creating/updating user data
 */
export interface UserDataFormData {
  country?: TaxCountryCode;
  taxNumber?: string;
  ownEmails?: string[];

  /** Personal entity data */
  personalEntity?: IdentityEntityFormData;

  /** Company entities data */
  companies?: IdentityEntityFormData[];

  // Deprecated fields for backward compatibility
  name?: string;
  companyName?: string;
  aliases?: string[];
  vatIds?: string[];
  ibans?: string[];
  markedAsMe?: string[];
  identityPartnerIds?: {
    name?: string;
    companyName?: string;
  };
}

/**
 * Invoice direction based on user data analysis
 */
export type InvoiceDirection = "incoming" | "outgoing" | "unknown";
