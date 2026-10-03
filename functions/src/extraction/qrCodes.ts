/**
 * Machine-readable payloads printed as QR codes (#540, groundwork for #166).
 *
 * Several countries print a QR code in a FIXED format, and a fixed format can
 * be parsed by code instead of read by a model:
 *
 *  - RKSV (Austria, Registrierkassensicherheitsverordnung): every receipt from
 *    a registered till carries `_R1-AT<n>_<kasse>_<beleg>_<timestamp>_`, the
 *    gross turnover at each of the five rate buckets and the turnover
 *    counter, signed by the till.
 *  - EPC069-12 "GiroCode" (SEPA credit transfer, common in AT/DE/NL/BE/FI):
 *    `BCD` + payee name, IBAN, amount and reference, one per line.
 *  - Swiss QR-bill (`SPC`): creditor IBAN, name, country, amount, currency.
 *
 * The model is asked to return the DECODED text of every code it can read.
 * Its decoding is a reading like any other, so nothing here trusts it on its
 * own: the caller only uses a parsed figure where an independent check holds
 * (the RKSV buckets must add up to the document total, an IBAN must pass its
 * checksum). A QR that is only a URL (many tills print a verification link)
 * parses as `url` and is kept as evidence, nothing more.
 */

import { ExtractedRateGroup } from "../types/extraction";
import { vatInsideGross } from "./taxFacts";

export type QrCodeFormat = "rksv" | "epc" | "swissQr" | "url" | "unknown";

/**
 * The five turnover buckets of an RKSV code, in the order it prints them
 * (RKSV Anlage Z 4).
 */
export type RksvBucket = "normal" | "reduced1" | "reduced2" | "zero" | "special";

/** A receipt the till marks as not a sale: a cancellation or a training receipt. */
export type RksvReceiptKind = "cancellation" | "training";

export interface ParsedQrCode {
  format: QrCodeFormat;
  /** The decoded text as the model returned it (trimmed, capped). */
  payload: string;
  /** RKSV: till id and receipt number, as printed in the code. */
  cashRegisterId?: string;
  receiptNumber?: string;
  /** RKSV: the receipt timestamp, ISO date part (YYYY-MM-DD). */
  date?: string;
  /**
   * RKSV: gross turnover per bucket, cents, non-zero buckets only. `rate` is
   * null where the bucket does not name one rate (see RKSV_BUCKET_RATES).
   */
  grossByRate?: Array<{ bucket: RksvBucket; rate: number | null; gross: number }>;
  /** RKSV: set when the turnover counter marks a cancellation or training receipt. */
  receiptKind?: RksvReceiptKind;
  /** EPC / Swiss: the payee. */
  payeeName?: string;
  iban?: string;
  /** EPC / Swiss: the amount to pay, cents. */
  amount?: number;
  currency?: string;
  reference?: string;
  /** Swiss: the creditor's country. */
  country?: string;
}

const MAX_PAYLOAD_LENGTH = 2000;

/**
 * The rate each RKSV bucket stands for, per the BMF Erlass zur
 * Registrierkassenpflicht (GZ 2025-1.047.659), 3.3.4 and 4.6.6:
 *
 *  - Normal 20 %, Ermäßigt-1 10 %, Ermäßigt-2 13 %.
 *  - Null is not "0 % VAT". It collects exempt and non-taxable sales, cash
 *    payments against an invoice, margin-scheme sales (the whole price, though
 *    VAT is owed on the margin), vouchers and anything taxed at a rate the
 *    other buckets do not list. Its gross says nothing about the VAT inside.
 *  - Besonders held 19 % (Jungholz/Mittelberg) until 30 June 2026. Since
 *    1 July 2026 it also holds the 4.9 % on basic foods (RKSV Anlage Z 4 as of
 *    BGBl. II Nr. 134/2026: "Betrag-Satz-Besonders (19 %, 4,9 %)"), so the
 *    code alone cannot tell which rate a grocery receipt's amount is at.
 *
 * A bucket without a rate is never turned into a Rate Group (#166).
 */
const RKSV_BUCKETS: ReadonlyArray<{ bucket: RksvBucket; rate: number | null }> = [
  { bucket: "normal", rate: 20 },
  { bucket: "reduced1", rate: 10 },
  { bucket: "reduced2", rate: 13 },
  { bucket: "zero", rate: null },
  { bucket: "special", rate: null },
];

/**
 * An RKSV amount. The till prints "0,00" (German number format, BMF mustercode);
 * some print a point, and a German-locale till can group thousands ("1.234,56").
 */
const RKSV_AMOUNT = String.raw`(-?(?:\d{1,3}(?:\.\d{3})+,\d{2}|\d+[.,]\d{2}))`;

const RKSV_PATTERN = new RegExp(
  String.raw`^_R1-AT\d+_([^_]+)_([^_]+)_(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}` +
  `_${RKSV_AMOUNT}`.repeat(5) +
  String.raw`_([^_]*)_`
);

/**
 * The turnover counter of a cancellation or training receipt holds "STO" or
 * "TRA" instead of the encrypted counter: Base64 in the QR code, Base32 in the
 * OCR line (BMF mustercode, TurnoverCounterType). The plain word is accepted
 * too, in case a decoder hands it over decoded.
 */
function rksvReceiptKind(counter: string): RksvReceiptKind | undefined {
  const value = counter.replace(/=+$/, "");
  if (value === "U1RP" || value === "KNKE6" || value === "STO") return "cancellation";
  if (value === "VFJB" || value === "KRJEC" || value === "TRA") return "training";
  return undefined;
}

function rksvCents(value: string): number {
  const sign = value.startsWith("-") ? -1 : 1;
  const digits = value.replace(/^-/, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
  const [whole, fraction] = digits.split(".");
  return sign * (parseInt(whole, 10) * 100 + parseInt(fraction, 10));
}

function parseRksv(payload: string): ParsedQrCode | null {
  const match = RKSV_PATTERN.exec(payload);
  if (!match) return null;
  const buckets = match.slice(4, 9).map(rksvCents);
  return {
    format: "rksv",
    payload,
    cashRegisterId: match[1],
    receiptNumber: match[2],
    date: match[3],
    grossByRate: buckets
      .map((gross, i) => ({ ...RKSV_BUCKETS[i], gross }))
      .filter((bucket) => bucket.gross !== 0),
    receiptKind: rksvReceiptKind(match[9]),
  };
}

/** "EUR12.34" or "12.34" in a payment code, cents. */
function decimalCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([A-Z]{3})?(\d+(?:\.\d{1,2})?)$/.exec(value.trim());
  if (!match) return undefined;
  return Math.round(parseFloat(match[2]) * 100);
}

function parseEpc(payload: string): ParsedQrCode | null {
  const lines = payload.split(/\r?\n/);
  if (lines[0]?.trim() !== "BCD" || lines[3]?.trim() !== "SCT") return null;
  const amountLine = lines[7]?.trim();
  const iban = lines[6]?.replace(/\s/g, "").toUpperCase();
  return {
    format: "epc",
    payload,
    payeeName: lines[5]?.trim() || undefined,
    iban: iban || undefined,
    amount: decimalCents(amountLine),
    currency: /^[A-Z]{3}/.test(amountLine ?? "") ? amountLine?.slice(0, 3) : undefined,
    reference: (lines[9]?.trim() || lines[10]?.trim()) || undefined,
  };
}

function parseSwissQr(payload: string): ParsedQrCode | null {
  const lines = payload.split(/\r?\n/);
  if (lines[0]?.trim() !== "SPC") return null;
  const iban = lines[3]?.replace(/\s/g, "").toUpperCase();
  return {
    format: "swissQr",
    payload,
    iban: iban || undefined,
    payeeName: lines[5]?.trim() || undefined,
    country: lines[10]?.trim() || undefined,
    amount: decimalCents(lines[18]),
    currency: lines[19]?.trim() || undefined,
    reference: lines[28]?.trim() || undefined,
  };
}

/**
 * Drop the fields a format left unset. The code is stored on the file record,
 * and Firestore (like the self-host store) refuses an `undefined` value.
 */
function withoutUndefined(code: ParsedQrCode): ParsedQrCode {
  return Object.fromEntries(
    Object.entries(code).filter(([, value]) => value !== undefined)
  ) as unknown as ParsedQrCode;
}

/** Parse one decoded QR payload. Never throws; an unknown format is kept as such. */
export function parseQrPayload(raw: unknown): ParsedQrCode | null {
  if (typeof raw !== "string") return null;
  const payload = raw.trim().slice(0, MAX_PAYLOAD_LENGTH);
  if (!payload) return null;
  const parsed: ParsedQrCode =
    parseRksv(payload) ??
    parseEpc(payload) ??
    parseSwissQr(payload) ??
    (/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(payload)
      ? { format: "url", payload }
      : { format: "unknown", payload });
  return withoutUndefined(parsed);
}

export function parseQrPayloads(raw: unknown): ParsedQrCode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      parseQrPayload(
        typeof entry === "string" ? entry : (entry as { payload?: unknown } | null)?.payload
      )
    )
    .filter((code): code is ParsedQrCode => code !== null);
}

/** ISO 13616 mod-97 checksum. */
export function ibanChecksumValid(iban: string | undefined): boolean {
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * The per-rate block an RKSV code carries, when it accounts for the document
 * total to the cent, else null.
 *
 * The buckets are gross; net and VAT follow from the rate. The sum check is
 * what lets a model-decoded payload be used at all: a misread digit or an
 * invented code does not add up to the total the page prints. A sum below the
 * total is a partial cash payment, whose buckets cover only the cash part
 * (Erlass 4.6.6), and is refused like any other mismatch.
 *
 * Refused as well (#166): a cancellation or training receipt, which is not a
 * sale, and any amount in a bucket that names no single rate (Null,
 * Besonders), whose VAT the code does not determine.
 */
export function rateGroupsFromRksv(
  codes: ParsedQrCode[],
  documentTotal: number | null | undefined
): ExtractedRateGroup[] | null {
  if (typeof documentTotal !== "number" || !Number.isFinite(documentTotal) || documentTotal <= 0) {
    return null;
  }
  const rksv = codes.find((code) => code.format === "rksv" && code.grossByRate?.length);
  if (!rksv?.grossByRate) return null;
  const sum = rksv.grossByRate.reduce((acc, bucket) => acc + bucket.gross, 0);
  if (
    rksv.receiptKind ||
    sum !== documentTotal ||
    rksv.grossByRate.some((bucket) => bucket.gross < 0 || bucket.rate === null)
  ) {
    return null;
  }
  return rksv.grossByRate.map(({ rate, gross }) => {
    const vat = vatInsideGross(gross, rate as number);
    return { rate: rate as number, net: gross - vat, vat, gross };
  });
}

/** The first payment code's IBAN that passes its checksum, or null. */
export function ibanFromPaymentCodes(codes: ParsedQrCode[]): string | null {
  for (const code of codes) {
    if ((code.format === "epc" || code.format === "swissQr") && ibanChecksumValid(code.iban)) {
      return code.iban as string;
    }
  }
  return null;
}

/** The first payment code's amount, cents, or null. */
export function amountFromPaymentCodes(codes: ParsedQrCode[]): number | null {
  for (const code of codes) {
    if ((code.format === "epc" || code.format === "swissQr") && typeof code.amount === "number" && code.amount > 0) {
      return code.amount;
    }
  }
  return null;
}
