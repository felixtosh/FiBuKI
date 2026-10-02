/**
 * Machine-readable payloads printed as QR codes (#540, groundwork for #166).
 *
 * Several countries print a QR code in a FIXED format, and a fixed format can
 * be parsed by code instead of read by a model:
 *
 *  - RKSV (Austria, Registrierkassensicherheitsverordnung): every receipt from
 *    a registered till carries `_R1-AT<n>_<kasse>_<beleg>_<timestamp>_` and
 *    the gross turnover at each of the five rate buckets, signed by the till.
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

export interface ParsedQrCode {
  format: QrCodeFormat;
  /** The decoded text as the model returned it (trimmed, capped). */
  payload: string;
  /** RKSV: till id and receipt number, as printed in the code. */
  cashRegisterId?: string;
  receiptNumber?: string;
  /** RKSV: the receipt timestamp, ISO date part (YYYY-MM-DD). */
  date?: string;
  /** RKSV: gross turnover per rate, cents, non-zero buckets only. */
  grossByRate?: Array<{ rate: number; gross: number }>;
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
 * RKSV buckets in the order the code prints them (RKSV § 9, Anlage Z 4):
 * Normal 20 %, Ermäßigt-1 10 %, Ermäßigt-2 13 %, Null 0 %, Besonders 19 %.
 */
const RKSV_BUCKET_RATES = [20, 10, 13, 0, 19] as const;

const RKSV_PATTERN =
  /^_R1-AT\d+_([^_]+)_([^_]+)_(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}_(-?\d+,\d{2})_(-?\d+,\d{2})_(-?\d+,\d{2})_(-?\d+,\d{2})_(-?\d+,\d{2})_/;

function commaCents(value: string): number {
  const [whole, fraction] = value.split(",");
  const sign = whole.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(parseInt(whole, 10)) * 100 + parseInt(fraction, 10));
}

function parseRksv(payload: string): ParsedQrCode | null {
  const match = RKSV_PATTERN.exec(payload);
  if (!match) return null;
  const buckets = match.slice(4, 9).map(commaCents);
  return {
    format: "rksv",
    payload,
    cashRegisterId: match[1],
    receiptNumber: match[2],
    date: match[3],
    grossByRate: buckets
      .map((gross, i) => ({ rate: RKSV_BUCKET_RATES[i], gross }))
      .filter((bucket) => bucket.gross !== 0),
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
 * invented code does not add up to the total the page prints.
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
  if (sum !== documentTotal || rksv.grossByRate.some((bucket) => bucket.gross < 0)) {
    return null;
  }
  return rksv.grossByRate.map(({ rate, gross }) => {
    const vat = vatInsideGross(gross, rate);
    return { rate, net: gross - vat, vat, gross };
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
