/**
 * The Bank Account kinds, and what a Cash Box (#787) refuses.
 *
 * A Cash Box is a Bank Account with no bank behind it: a name and a currency,
 * nothing a bank would print. It never carries a balance, because FiBuKI
 * cannot know what is in the box.
 */

import { HttpsError } from "../utils/createCallable";

export const ACCOUNT_KINDS = ["bank_account", "credit_card", "depot", "cash"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === "string" && (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/** Fields a bank, a card or a broker would fill, which a Cash Box has none of. */
const NOT_ON_A_CASH_BOX: Record<string, string> = {
  iban: "an IBAN",
  cardLast4: "card digits",
  cardBrand: "a card brand",
  linkedSourceId: "a linked account",
  brokerName: "a broker",
  openingBalance: "an opening balance",
  openingBalanceDate: "an opening balance",
  openingBalanceSource: "an opening balance",
  latestBalance: "a balance",
  latestBalanceDate: "a balance",
};

/** The fields to clear when a Bank Account becomes a Cash Box. */
export const CASH_BOX_CLEARED_FIELDS = Object.keys(NOT_ON_A_CASH_BOX);

/** Refuses a non-empty bank, card, broker or balance field on a Cash Box. */
export function refuseBankFieldsOnCashBox(data: Record<string, unknown>): void {
  for (const [field, what] of Object.entries(NOT_ON_A_CASH_BOX)) {
    const value = data[field];
    if (value !== undefined && value !== null && value !== "") {
      throw new HttpsError(
        "invalid-argument",
        `A Cash Box has no bank behind it and takes only a name and a currency, not ${what}.`
      );
    }
  }
}

/**
 * The account-kind rules a create or an update applies before writing:
 * refuses an unknown kind naming the known ones, and, when the Bank Account
 * is or becomes a Cash Box, any bank, card, broker or balance field. On an
 * update, `storedKind` is the kind already stored, which applies when the
 * update names none.
 */
export function refuseInvalidAccountKindFields(data: { accountKind?: unknown }, storedKind?: unknown): void {
  if (data.accountKind !== undefined && !isAccountKind(data.accountKind)) {
    throw new HttpsError(
      "invalid-argument",
      `Unknown account kind "${String(data.accountKind)}"; use one of ${ACCOUNT_KINDS.join(", ")}`
    );
  }
  if ((data.accountKind ?? storedKind) === "cash") {
    refuseBankFieldsOnCashBox(data as Record<string, unknown>);
  }
}
