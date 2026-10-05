# Extraction Service contract (version 1)

An **Extraction Service** performs an Extraction end to end. It takes a File's bytes,
decides whether the File is a financial document, and returns its transcription. Gemini
is the built-in one. A deployment may configure an external one instead, for example a
local model on the same box, so that documents never leave it.

FiBuKI never renders a PDF and never runs OCR. Whatever a service needs for that (page
images, a text layer, a barcode decoder) happens inside the service. FiBuKI sends the
File's own bytes and reads back a transcription.

The machine-readable contract is in [`request.schema.json`](request.schema.json) and
[`response.schema.json`](response.schema.json) (JSON Schema 2020-12). FiBuKI validates
every response against the response schema. This page explains it.

## What stays FiBuKI's

The service transcribes; it does not decide. Its transcription is the same JSON the
built-in Gemini prompt asks for, and FiBuKI reads it exactly as it reads Gemini's reply:
VAT ID and website normalisation, the country from the VAT ID prefix, entity decoding,
the Invoicing Agent guard (ADR-0003), QR payload parsing, and the closed vocabulary for
additional fields. Direction, the VAT guards, Line Item reconciliation and the Document
Type follow, as for any Extraction. A service therefore cannot make an Invoicing Agent the
Partner, and a field key outside the vocabulary is discarded.

## Configuration

Per deployment, never per user: it is infrastructure, and a user-supplied URL would have
FiBuKI call arbitrary addresses from inside its own network.

| Variable | Meaning |
|---|---|
| `FIBUKI_EXTRACTION_SERVICE_URL` | The endpoint, `http` or `https`. When set, every File of the deployment goes to it. |
| `FIBUKI_EXTRACTION_SERVICE_TOKEN` | Optional. Sent as `Authorization: Bearer <token>`. |
| `FIBUKI_EXTRACTION_TIMEOUT_SECONDS` | How long one Extraction may take, the call included. Default 300. |
| `FIBUKI_EXTRACTION_CONCURRENCY` | Extractions at once per API replica. Default 1 with a service, 4 with Gemini. |

Redirects are not followed. Use `https` unless the service is on the same private
network: the request carries the whole document.

## The request

One synchronous `POST` with a JSON body, per File:

```json
{
  "contractVersion": "1",
  "file": {
    "name": "rechnung-2026-01.pdf",
    "mimeType": "application/pdf",
    "contentBase64": "JVBERi0xLjQK..."
  },
  "treatAsInvoice": false
}
```

- `mimeType` is sniffed from the bytes, not taken from the File's metadata.
- `treatAsInvoice` is `true` when the user overrode the invoice check ("treat as
  invoice"). The answer must then be a transcription.
- Nothing else is sent: no File id, no user id, no identity data. Direction and Partner
  are decided by FiBuKI after the response.

## The response

HTTP 2xx with a JSON body, one of two outcomes. Both name the service and its version;
FiBuKI records both on the Extraction.

**Not a financial document** (a bank statement, a contract without amounts, a tax form):

```json
{
  "contractVersion": "1",
  "service": { "name": "my-local-extractor", "version": "0.3.1" },
  "outcome": "notFinancialDocument",
  "reason": "Bank statement",
  "confidence": 0.9
}
```

`confidence` (0 to 1) is optional; a missing one reads as 0.5, as with Gemini's check.

**A transcription:**

```json
{
  "contractVersion": "1",
  "service": { "name": "my-local-extractor", "version": "0.3.1" },
  "outcome": "transcription",
  "transcription": {
    "rawText": "Rechnung Nr. 2026-0042 ...",
    "extracted": {
      "date": "2026-01-15",
      "date_raw": "15.01.2026",
      "amount": 12000,
      "amount_raw": "120,00 €",
      "currency": "EUR",
      "vatPercent": 20,
      "documentVatAmount": 2000,
      "invoiceNumber": "2026-0042",
      "confidence": 0.85,
      "issuer": { "name": "Lieferant GmbH", "vatId": "ATU12345678", "address": "..." },
      "recipient": { "name": "..." }
    },
    "qrCodes": [
      { "payload": "_R1-AT0_K1_42_...", "decodedBy": "barcode" }
    ],
    "segments": null,
    "additionalFields": [
      { "key": "dueDate", "label": "Fällig am", "value": "2026-01-29", "rawValue": "29.01.2026" }
    ]
  },
  "usage": { "inputTokens": 1830, "outputTokens": 412 }
}
```

The fields and their meaning are those of the built-in prompt, and the schema carries the
full list. In short: money in whole cents, dates as `YYYY-MM-DD`, every value exactly as
printed and `null` when the document does not print it, `_raw` spellings beside the values
for highlighting, the issuer, recipient and Invoicing Agent each in their own block, and
`segments` only when one File holds two or more separately issued documents. Unknown keys
are ignored.

### QR codes

Each entry of `qrCodes` is either the decoded payload as a string, or an object
`{ "payload": "...", "decodedBy": "barcode" | "model" }`. `decodedBy` says whether a
barcode decoder read the payload or a model transcribed it. A string, or an object without
`decodedBy`, means `"model"`: FiBuKI never assumes a deterministic read it was not told
about. FiBuKI stores `decodedBy` with the parsed code. What it does differently with a
`"barcode"` payload is not decided yet; today both are treated as a model's reading.

### Usage

`usage` is optional. FiBuKI logs one call per Extraction under the service's name, with
the reported token counts or zero, and computes no cost.

## Failure

There is no fallback. A service that cannot be reached, answers a non-2xx status, does not
answer within the timeout, returns something that is not JSON or fails the schema, or
answers "not a financial document" to a request with `treatAsInvoice`, fails the
Extraction. The File shows the error and the normal Retry applies. Falling back to Gemini
would ship a document off a box whose owner chose to keep it local.

## Provenance

Every Extraction records which service produced it: `gemini` or `external`, the service's
own name and version (for Gemini, `gemini` and the model id), and the contract version.
Files extracted before this contract existed carry none of it and read as Gemini. Since a
service always receives the File's own bytes, that is all an Extraction needs to say about
its input.

## Versions

This is version `1`. A change to either schema is a new version; a service answering
another version fails the Extraction. FiBuKI does not ship a reference service: building
one would be rendering by another name.
