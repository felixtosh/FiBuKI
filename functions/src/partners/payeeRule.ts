/**
 * The payee rule (#550, ADR-0011): which Partner a Transaction gets from the
 * Files connected to it.
 *
 * A Transaction's Partner is the payee, the business the money went to. A
 * File's Partner is the supplier, the business that did the work (ADR-0003).
 * They differ on a marketplace charge (one Amazon line, three sellers) and on
 * an Uber ride (Uber is paid, the taxi operator did the work), so a File's
 * Partner never overwrites a Transaction's. It may fill an empty one, and only
 * when every File on the Transaction names the same Partner.
 *
 * Nothing flows the other way: the payee is not evidence of the supplier, so a
 * File without a Partner waits for Partner matching or a person.
 *
 * Pure, with no database import, so the connect step in the browser and the
 * server writers apply the identical rule.
 */

/** A connected File's Partner, as stored on the File. */
export interface FilePartnerRef {
  partnerId?: string | null;
  partnerType?: string | null;
  partnerMatchConfidence?: number | null;
}

/** The Partner fields a fill writes onto the Transaction. */
export interface PayeeFill {
  partnerId: string;
  partnerType: string;
  partnerMatchedBy: "auto";
  partnerMatchConfidence: number | null;
}

/**
 * The Partner every File names, or null when they do not all name one and
 * the same. A File without a Partner names none, so it blocks agreement.
 */
export function agreedFilePartnerId(files: readonly FilePartnerRef[]): string | null {
  if (files.length === 0) return null;
  const first = files[0].partnerId ?? null;
  if (!first) return null;
  return files.every((f) => (f.partnerId ?? null) === first) ? first : null;
}

/**
 * What a Transaction's Partner becomes from its connected Files: the fill to
 * write, or null to leave the Transaction as it is.
 *
 * `files` is every File connected to the Transaction once the current change
 * has landed, the one being connected included.
 */
export function payeeFillFromFiles(
  transaction: { partnerId?: string | null },
  files: readonly FilePartnerRef[]
): PayeeFill | null {
  if (transaction.partnerId) return null;
  const agreed = agreedFilePartnerId(files);
  if (!agreed) return null;
  const source = files.find((f) => f.partnerId === agreed)!;
  return {
    partnerId: agreed,
    partnerType: source.partnerType ?? "user",
    partnerMatchedBy: "auto",
    partnerMatchConfidence: source.partnerMatchConfidence ?? null,
  };
}

/**
 * The Partner a BMD Export books a Transaction to (its Personenkonto): the
 * Partner every connected File names when they agree, so a one-supplier line
 * books to its supplier as it did before the payee rule; the Transaction's
 * Partner, the payee, otherwise, including when no File has a Partner.
 */
export function personenkontoPartnerId(
  transactionPartnerId: string | null | undefined,
  files: readonly FilePartnerRef[]
): string | null {
  return agreedFilePartnerId(files) ?? transactionPartnerId ?? null;
}
