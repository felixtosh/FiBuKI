// AUTO-GENERATED — DO NOT EDIT
// Source: functions/src/tools/definitions.ts
// Regenerate: npm run generate:tool-definitions

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  requiredFeature?: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    "name": "list_sources",
    "description": "List all bank accounts/sources for the user",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "get_source",
    "description": "Get details of a specific bank account by ID",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sourceId": {
          "type": "string",
          "description": "The bank account ID"
        }
      },
      "required": [
        "sourceId"
      ]
    }
  },
  {
    "name": "create_source",
    "description": "Create a new bank account/source",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Name of the bank account"
        },
        "accountKind": {
          "type": "string",
          "enum": [
            "bank_account",
            "credit_card"
          ],
          "description": "Type of account (default: bank_account)"
        },
        "iban": {
          "type": "string",
          "description": "IBAN (optional)"
        },
        "currency": {
          "type": "string",
          "description": "Currency code (default: EUR)"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "delete_source",
    "description": "Delete a bank account and all associated imports/transactions (cascade). Requires confirm: true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sourceId": {
          "type": "string",
          "description": "The bank account ID to delete"
        },
        "confirm": {
          "type": "boolean",
          "description": "Must be true to confirm deletion"
        }
      },
      "required": [
        "sourceId",
        "confirm"
      ]
    }
  },
  {
    "name": "list_transactions",
    "description": "List transactions with optional filters. Dates are YYYY-MM-DD (local timezone). Amounts in cents. Returns { transactions, nextCursor, count }. Pass nextCursor back as cursor for the next page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sourceId": {
          "type": "string",
          "description": "Filter by bank account ID"
        },
        "dateFrom": {
          "type": "string",
          "description": "Start date inclusive (YYYY-MM-DD). Pushed into the query, applied before limit."
        },
        "dateTo": {
          "type": "string",
          "description": "End date inclusive (YYYY-MM-DD). Pushed into the query, applied before limit."
        },
        "search": {
          "type": "string",
          "description": "Substring match on name/description/partner. Applied after fetch so pagination is approximate when combined with cursor."
        },
        "isComplete": {
          "type": "boolean",
          "description": "Filter by completion status"
        },
        "limit": {
          "type": "number",
          "description": "Max results per page (default 50, max 500)"
        },
        "cursor": {
          "type": "string",
          "description": "nextCursor from the previous response to fetch the next page"
        }
      }
    }
  },
  {
    "name": "get_transaction",
    "description": "Get full details of a transaction by ID",
    "inputSchema": {
      "type": "object",
      "properties": {
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        }
      },
      "required": [
        "transactionId"
      ]
    }
  },
  {
    "name": "update_transaction",
    "description": "Update a transaction's description, completion status, or manual VAT-rate override (the override feeds the UVA calculation when no receipt resolves the rate)",
    "inputSchema": {
      "type": "object",
      "properties": {
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        },
        "description": {
          "type": "string",
          "description": "Description for tax purposes"
        },
        "isComplete": {
          "type": "boolean",
          "description": "Mark as complete/incomplete"
        },
        "vatRate": {
          "type": [
            "number",
            "null"
          ],
          "description": "Manual VAT rate override for UVA derivation: one of 0, 4.9, 10, 13, 19, 20. Pass null to clear. The calculation still validates the rate against the transaction's period."
        },
        "isReverseCharge": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Reverse-charge classification for UVA derivation: true forces the §19 service regime (KZ 057/066), false vetoes the automatic foreign-supplier heuristic, null clears and lets the heuristic decide."
        }
      },
      "required": [
        "transactionId"
      ]
    }
  },
  {
    "name": "list_transactions_needing_files",
    "description": "Find transactions without receipts (no files, no category). Returns { transactions, nextCursor, count }. `count` is the size of this page, not a total — page with nextCursor until it comes back null to see everything that still needs a receipt.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "minAmount": {
          "type": "number",
          "description": "Minimum amount in cents"
        },
        "limit": {
          "type": "number",
          "description": "Max results per page (default 50, max 500)"
        },
        "cursor": {
          "type": "string",
          "description": "nextCursor from the previous response to fetch the next page"
        }
      }
    }
  },
  {
    "name": "list_transactions_missing_invoice",
    "description": "Find transactions documented by a receipt only — money moved, a document is attached, but no invoice satisfying § 11 UStG was ever received, so no Vorsteuer may be claimed. These lines look complete everywhere else. Returns { transactions, nextCursor, count } where each row carries the vendor, the amount, the date and the § 11 elements the attached document is missing, so a request to the supplier can name the defect. `count` is the size of this page, not a total — page with nextCursor until it comes back null.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "minAmount": {
          "type": "number",
          "description": "Minimum absolute amount in cents — the deductions worth chasing first"
        },
        "limit": {
          "type": "number",
          "description": "Max results per page (default 50, max 500)"
        },
        "cursor": {
          "type": "string",
          "description": "nextCursor from the previous response to fetch the next page"
        }
      }
    }
  },
  {
    "name": "import_transactions",
    "description": "Import pre-mapped transactions into a source. Transactions must include date, amount, name, and currency.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sourceId": {
          "type": "string",
          "description": "The source/bank account ID to import into"
        },
        "transactions": {
          "type": "array",
          "description": "Array of transaction objects",
          "items": {
            "type": "object",
            "properties": {
              "date": {
                "type": "string",
                "description": "Transaction date (ISO format)"
              },
              "amount": {
                "type": "number",
                "description": "Amount in cents (negative for expenses)"
              },
              "currency": {
                "type": "string",
                "description": "Currency code (e.g. EUR)"
              },
              "name": {
                "type": "string",
                "description": "Transaction name/payee"
              },
              "description": {
                "type": "string",
                "description": "Optional description"
              },
              "partner": {
                "type": "string",
                "description": "Optional partner/counterparty name"
              },
              "reference": {
                "type": "string",
                "description": "Optional reference number"
              },
              "partnerIban": {
                "type": "string",
                "description": "Optional partner IBAN"
              }
            },
            "required": [
              "date",
              "amount",
              "currency",
              "name"
            ]
          }
        }
      },
      "required": [
        "sourceId",
        "transactions"
      ]
    }
  },
  {
    "name": "list_files",
    "description": "List uploaded files (receipts/invoices) with match suggestions",
    "inputSchema": {
      "type": "object",
      "properties": {
        "hasConnections": {
          "type": "boolean",
          "description": "true = matched, false = unmatched"
        },
        "hasSuggestions": {
          "type": "boolean",
          "description": "Filter by suggestion availability"
        },
        "needsVatRateReview": {
          "type": "boolean",
          "description": "true = only files printing a VAT rate Austria does not have (anything outside 0/10/13/20 on the document's date). Each such file reports the offending rates in vatRatesOutsideSet. 11% is Versicherungssteuer, not VAT, and is not deductible — mark those with mark_file_vat_not_claimable."
        },
        "handCorrected": {
          "type": "boolean",
          "description": "true = only files whose extracted record a human corrected by hand. Each such file reports the fields in extractionCorrectedFields (field name -> when it was set) and the newest of them in extractionCorrectedAt. This is the exclusion list for a re-extraction sweep — retry_file_extraction refuses these files unless overwriteCorrections is passed."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 50)"
        }
      }
    }
  },
  {
    "name": "get_file",
    "description": "Get file details including extracted data and suggestions",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        }
      },
      "required": [
        "fileId"
      ]
    }
  },
  {
    "name": "connect_file_to_transaction",
    "description": "Connect a file (receipt) to a transaction, marking it complete. A pair that was previously rejected is refused with PAIR_REJECTED; lift the rejection with undismiss_transaction_suggestion first if the connection is genuinely intended.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        }
      },
      "required": [
        "fileId",
        "transactionId"
      ]
    }
  },
  {
    "name": "disconnect_file_from_transaction",
    "description": "Disconnect a file from a transaction",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        }
      },
      "required": [
        "fileId",
        "transactionId"
      ]
    }
  },
  {
    "name": "mark_file_vat_not_claimable",
    "description": "Record that the VAT this document prints must not be claimed as Vorsteuer, with the reason. Use for a figure that looks like VAT and is not: 11% on an insurance policy is Versicherungssteuer and insurance is VAT-exempt (insurance-tax), another public charge printed in the VAT column (levy), a 100% discount leaving nothing due (discount-to-zero), or private consumption (private). The UVA derivation then books the document's gross at 0% and lists the excluded VAT under nonClaimableVat instead of putting it on the receipt-chasing list as recoverable. Nothing extracted is touched — the document still says what it says. Reversible with unmark_file_vat_not_claimable.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "reason": {
          "type": "string",
          "enum": [
            "insurance-tax",
            "levy",
            "discount-to-zero",
            "private"
          ],
          "description": "Why the VAT is not deductible"
        },
        "note": {
          "type": "string",
          "description": "Free-text detail stored with the reason, max 500 characters"
        }
      },
      "required": [
        "fileId",
        "reason"
      ]
    }
  },
  {
    "name": "unmark_file_vat_not_claimable",
    "description": "Clear a file's non-claimable VAT marker, so its VAT is deductible again. The extracted figures never changed, so the derivation resumes reading them as printed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        }
      },
      "required": [
        "fileId"
      ]
    }
  },
  {
    "name": "dismiss_transaction_suggestion",
    "description": "Reject a proposed file-to-transaction pair. Removes the suggestion from the file's suggestion list and records the rejection so re-scoring does not propose it again. Use for a genuinely wrong pair (coincidental amount or date, an own-side document scored against an expense line). Do NOT use when the pair is correct but the transaction already holds a document. Reversible with undismiss_transaction_suggestion.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "transactionId": {
          "type": "string",
          "description": "The transaction ID to reject"
        },
        "reason": {
          "type": "string",
          "description": "Why the pair is wrong — stored with the rejection, max 500 characters"
        }
      },
      "required": [
        "fileId",
        "transactionId"
      ]
    }
  },
  {
    "name": "undismiss_transaction_suggestion",
    "description": "Clear a previous rejection of a file-to-transaction pair, making it eligible to be suggested again. Does not itself regenerate the suggestion — the pair reappears when matching next runs for that file (a partner change, a precision search, or the UI's refresh-matches action), or can be scored on demand with score_file_transaction_match. The earlier rejection stays in the file's history.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "transactionId": {
          "type": "string",
          "description": "The transaction ID to un-reject"
        }
      },
      "required": [
        "fileId",
        "transactionId"
      ]
    }
  },
  {
    "name": "mark_file_as_not_invoice",
    "description": "Flag a file as not an invoice (duplicate re-send, payment reminder, statement, anything that documents nothing). Clears its extracted data and takes it out of the unmatched-file queue. Refuses while the file is still connected to a transaction. Reversible with unmark_file_as_not_invoice.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "reason": {
          "type": "string",
          "description": "Why it is not an invoice — stored on the file"
        }
      },
      "required": [
        "fileId"
      ]
    }
  },
  {
    "name": "unmark_file_as_not_invoice",
    "description": "Restore a file previously flagged as not an invoice. Re-opens extraction, which recovers the fields marking cleared.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        }
      },
      "required": [
        "fileId"
      ]
    }
  },
  {
    "name": "update_file_extraction",
    "description": "Correct a file's extracted record by hand. Use when re-extraction cannot get there because the right value needs judgement the document does not state unambiguously — a Schlussrechnung printing both the full amount and the part already invoiced, VAT that is correctly read but not claimable, a one-cent OCR slip inside the reconciliation tolerance. Only the fields you pass are touched; pass null to clear one. The corrected total is NOT re-derived from the line items, so an amount that deliberately differs from them survives. Correcting anything VAT-bearing makes you the authority on the file: stored reconciliation flags and extraction-provenance markers are cleared, because they would otherwise outrank what you just set. Every correction records which fields you set and when, in extractionCorrectedFields — from then on retry_file_extraction refuses the file unless overwriteCorrections is passed, and list_files can return the corrected population with handCorrected: true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "amount": {
          "type": [
            "number",
            "null"
          ],
          "description": "Document total in cents. Negative is legal (a credit note)."
        },
        "vatAmount": {
          "type": [
            "number",
            "null"
          ],
          "description": "Document VAT in cents"
        },
        "vatPercent": {
          "type": [
            "number",
            "null"
          ],
          "description": "Document VAT rate, 0-100. Zero is a real correction — use it for a document whose VAT must not be claimed — and is not the same as null, which clears the rate."
        },
        "date": {
          "type": [
            "string",
            "null"
          ],
          "description": "Document date as YYYY-MM-DD"
        },
        "lineItems": {
          "type": [
            "array",
            "null"
          ],
          "description": "Replace the itemisation wholesale. Each item: description, amount (cents, GROSS — the amount includes its own VAT), vatPercent, vatAmount (cents), and optionally quantity and unitPrice.",
          "items": {
            "type": "object",
            "properties": {
              "description": {
                "type": "string"
              },
              "amount": {
                "type": "number"
              },
              "vatPercent": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "vatAmount": {
                "type": "number"
              },
              "quantity": {
                "type": [
                  "number",
                  "null"
                ]
              },
              "unitPrice": {
                "type": [
                  "number",
                  "null"
                ]
              }
            },
            "required": [
              "amount"
            ]
          }
        }
      },
      "required": [
        "fileId"
      ]
    }
  },
  {
    "name": "retry_file_extraction",
    "description": "Re-run extraction on a file. Use when a file extracted without erroring but produced nothing usable — no line items, no VAT amount, a wrong total — which is the case the UI's retry button did not cover. Extraction runs synchronously and can take up to a minute. Re-extracting resets partner and transaction matching for the file so both re-run against the new data; a manual partner assignment is kept. A file that already extracted cleanly needs force: true. A file carrying hand corrections is refused with HAND_CORRECTED, naming the fields a person set — re-extraction would discard them, so overwriting takes its own flag, per file. Sweep over list_files with handCorrected: true first if you want to know which files that will be.",
    "requiredFeature": "aiExtraction",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "force": {
          "type": "boolean",
          "description": "Re-extract a file whose extraction completed without error. Required for that case, ignored otherwise."
        },
        "overwriteCorrections": {
          "type": "boolean",
          "description": "Re-extract a file whose record a human corrected, replacing what they set with whatever the model reads this time. Deliberately separate from force, which sweeps and the UI pass as a matter of habit — decide this one per file, having read the fields the refusal names."
        }
      },
      "required": [
        "fileId"
      ]
    }
  },
  {
    "name": "reclassify_documents",
    "description": "Re-run the § 11 UStG document classifier over every stored file and then re-derive the documentation state of every transaction, whole account, in that order. This is what puts invoice/receipt on records that were stored before the classifier existed or before a rule fix — it never re-extracts, spends no AI call and touches no extracted field, so a hand correction cannot be destroyed. Defaults to a dry run: pass dryRun=false to write. Writes only where the value actually moved, so a second run in a row writes nothing. Returns summary counts only — by document type, by basis reason and by documentation state, never per-file rows. Inspect the result with list_transactions_missing_invoice.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "dryRun": {
          "type": "boolean",
          "description": "Default true — classify and report only, nothing written. Pass false to persist."
        }
      }
    }
  },
  {
    "name": "auto_connect_file_suggestions",
    "description": "Auto-connect files to transactions above confidence threshold",
    "requiredFeature": "aiMatching",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "Specific file ID (optional)"
        },
        "minConfidence": {
          "type": "number",
          "description": "Min confidence 0-100 (default 89)"
        }
      }
    }
  },
  {
    "name": "upload_file",
    "description": "Upload a file from a URL or base64 data",
    "requiredFeature": "fileUpload",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "URL to download file from"
        },
        "base64": {
          "type": "string",
          "description": "Base64-encoded file content (alternative to url)"
        },
        "fileName": {
          "type": "string",
          "description": "File name with extension"
        },
        "mimeType": {
          "type": "string",
          "description": "MIME type (e.g. application/pdf, image/jpeg)"
        }
      },
      "required": [
        "fileName",
        "mimeType"
      ]
    }
  },
  {
    "name": "score_file_transaction_match",
    "description": "Score how well a file matches a transaction (0-100 confidence)",
    "requiredFeature": "aiMatching",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "The file ID"
        },
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        }
      },
      "required": [
        "fileId",
        "transactionId"
      ]
    }
  },
  {
    "name": "list_identity_entities",
    "description": "List the user's identity entities (personalEntity + companies). Each entry has id, name, type (person|company), optional vatId, ibans[], and optional address. Use the returned id as `issuerEntityId` in update_invoice / create_invoice.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "update_identity_entity",
    "description": "Patch an existing identity entity (personal or company). Accepts a sparse patch of name, vatId, ibans (full replacement array), aliases, and address ({street, postalCode, city, country}). Use this to bring an entity up to invoice-ready state without going through the settings UI.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "entityId": {
          "type": "string",
          "description": "Identity entity id (from list_identity_entities)"
        },
        "patch": {
          "type": "object",
          "description": "Sparse patch — only include fields you want to change",
          "properties": {
            "name": {
              "type": "string"
            },
            "vatId": {
              "type": "string"
            },
            "ibans": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "aliases": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "address": {
              "type": "object",
              "properties": {
                "street": {
                  "type": "string"
                },
                "postalCode": {
                  "type": "string"
                },
                "city": {
                  "type": "string"
                },
                "country": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "required": [
        "entityId",
        "patch"
      ]
    }
  },
  {
    "name": "list_partners",
    "description": "List user partners with optional search. Each partner carries `billingCycle`: the effective cycle plus the learned and declared halves it was resolved from, one entry per recurrence (null when the partner does not bill on a schedule).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "search": {
          "type": "string",
          "description": "Search in partner name and aliases"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 50, max 100)"
        }
      }
    }
  },
  {
    "name": "get_partner",
    "description": "Get partner details by ID, including `billingCycle`: the effective cycle plus the learned and declared halves it was resolved from, one entry per recurrence (a partner can bill in more than one amount band).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "partnerId": {
          "type": "string",
          "description": "The partner ID"
        }
      },
      "required": [
        "partnerId"
      ]
    }
  },
  {
    "name": "set_partner_billing_cycle",
    "description": "Declare, change or clear the DECLARED billing cycle of a partner. A declaration wins over what Fibuki learned from the transaction history; the learned half stays visible beside it and is never touched here. Pass one recurrence or an array of them (a partner can bill in more than one amount band), or `declared: null` to clear every declaration and fall back to what was learned.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "partnerId": {
          "type": "string",
          "description": "The partner ID"
        },
        "declared": {
          "description": "The declared recurrence, an array of recurrences, or null to clear. Give either `cadence` or `frequencyDays`.",
          "properties": {
            "cadence": {
              "type": "string",
              "enum": [
                "weekly",
                "monthly",
                "quarterly",
                "yearly"
              ],
              "description": "Named cadence — 7, 30, 90 or 365 days"
            },
            "frequencyDays": {
              "type": "number",
              "description": "Days between charges, for a cadence with no name (every N days)"
            },
            "amountBand": {
              "type": "number",
              "description": "Absolute amount in cents this recurrence bills, when the partner has more than one (e.g. a weekly API charge beside a monthly subscription). Derived from expectedAmountMin/Max when those are given."
            },
            "expectedAmountMin": {
              "type": "number",
              "description": "Lowest expected amount in cents"
            },
            "expectedAmountMax": {
              "type": "number",
              "description": "Highest expected amount in cents"
            },
            "currency": {
              "type": "string",
              "description": "Currency the recurrence is billed in (e.g. USD) — a USD subscription stays one recurrence although the booked EUR amount drifts"
            },
            "documentExpectation": {
              "type": "string",
              "enum": [
                "invoice",
                "no-receipt-category",
                "nothing"
              ],
              "description": "What each charge is expected to carry (default: invoice). Use 'nothing' for charges that by rule never produce a document (bank fees, SVS, insolvency instalments) so they never read as missing one."
            }
          }
        }
      },
      "required": [
        "partnerId",
        "declared"
      ]
    }
  },
  {
    "name": "list_recurring_partners",
    "description": "List the partners that bill on a schedule, with everything a subscription view needs per partner: the billing cycle, the last charge seen (date, amount in the billed currency and in EUR, transaction id), the next expected charge window, and how many of its charges in the date range carry their expected document. `recurrences` splits all of that per amount band, so a vendor billing weekly and monthly reads as two rows. Amounts are absolute cents; `amountEur` is null when the account is not booked in EUR. Returns { partners, nextCursor, count, dateFrom, dateTo } — pass nextCursor back as `cursor` for the next page. Up to 200 charges per partner, ending at dateTo, are read.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "dateFrom": {
          "type": "string",
          "description": "Coverage range start, inclusive (YYYY-MM-DD). Default: 13 months before dateTo."
        },
        "dateTo": {
          "type": "string",
          "description": "Coverage range end, inclusive (YYYY-MM-DD). Default: today."
        },
        "limit": {
          "type": "number",
          "description": "Max partners per page (default 25, max 100)"
        },
        "cursor": {
          "type": "string",
          "description": "nextCursor from the previous response"
        }
      }
    }
  },
  {
    "name": "create_partner",
    "description": "Create a new user partner for transaction matching",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Partner/company name"
        },
        "aliases": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Alternative names"
        },
        "vatId": {
          "type": "string",
          "description": "VAT ID (e.g. ATU12345678)"
        },
        "ibans": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Partner IBANs"
        },
        "website": {
          "type": "string",
          "description": "Partner website"
        },
        "country": {
          "type": "string",
          "description": "Country code (e.g. AT, DE)"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "assign_partner_to_transaction",
    "description": "Assign a partner to a transaction for categorization",
    "inputSchema": {
      "type": "object",
      "properties": {
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        },
        "partnerId": {
          "type": "string",
          "description": "The partner ID"
        }
      },
      "required": [
        "transactionId",
        "partnerId"
      ]
    }
  },
  {
    "name": "remove_partner_from_transaction",
    "description": "Remove a partner assignment from a transaction",
    "inputSchema": {
      "type": "object",
      "properties": {
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        }
      },
      "required": [
        "transactionId"
      ]
    }
  },
  {
    "name": "partner_rematch_report",
    "description": "READ-ONLY. Re-runs the current partner matcher over transactions that ALREADY have a partner assigned and returns only the cases where its answer differs from what is stored: a different partner would be applied, or nothing would be applied because no candidate reaches the auto-apply threshold. Writes nothing — no assignment is changed and no false positive is recorded. Use it to review assignments made before a matcher fix; partner matching itself skips any transaction that already has a partner, so those are never re-scored on their own. Counts cover every evaluated transaction; `rows` is capped by `limit` and sets `truncated`.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "minConfidence": {
          "type": "number",
          "description": "Only stored assignments with confidence >= this value"
        },
        "maxConfidence": {
          "type": "number",
          "description": "Only stored assignments with confidence <= this value"
        },
        "assignedBefore": {
          "type": "string",
          "description": "ISO 8601 instant — only assignments recorded before it. Transactions whose automationHistory has no partner_assigned entry are kept (they are older, not newer)."
        },
        "matchedBy": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Which partnerMatchedBy values to review. Default [\"auto\",\"ai\"]; pass [\"manual\"] only to inspect human assignments, which should never be mechanically re-matched."
        },
        "includeAgreements": {
          "type": "boolean",
          "description": "Also return transactions where the matcher agrees (default false, disagreements only)"
        },
        "limit": {
          "type": "number",
          "description": "Max rows to return (default 50, max 500)"
        }
      }
    }
  },
  {
    "name": "rematch_assigned_partners",
    "description": "Re-run the current partner matcher over transactions that already have an AUTO-assigned partner, whole account, and write the corrected answer WITHOUT recording a false positive — unlike remove_partner_from_transaction, which blacklists the pair forever. Defaults to a dry run: pass dryRun=false to write. Reassigns where the matcher now picks a different partner and keeps where it agrees; an assignment it no longer reproduces is reported but left alone unless clearUnconfirmed=true. Never touches manual, suggestion or ai assignments. Review with partner_rematch_report first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "dryRun": {
          "type": "boolean",
          "description": "Default true — plan only, nothing written. Pass false to apply the plan."
        },
        "clearUnconfirmed": {
          "type": "boolean",
          "description": "Default false — an assignment the matcher no longer reproduces is reported as skip_clear_disabled and left in place, so the run applies only the reassignments it can prove. Pass true to also clear those, which is a much larger write set."
        },
        "minConfidence": {
          "type": "number",
          "description": "Only stored assignments with confidence >= this value"
        },
        "maxConfidence": {
          "type": "number",
          "description": "Only stored assignments with confidence <= this value"
        },
        "assignedBefore": {
          "type": "string",
          "description": "ISO 8601 instant — only assignments recorded before it (e.g. the deploy time of a matcher fix). Transactions with no recorded assignment time are kept."
        },
        "maxWrites": {
          "type": "number",
          "description": "Refuse to apply if the plan exceeds this many writes (default 1000). The run aborts before writing anything rather than applying half a plan."
        },
        "includeKept": {
          "type": "boolean",
          "description": "Include untouched (agreeing) transactions in rows (default false)"
        },
        "limit": {
          "type": "number",
          "description": "Max rows to return (default 100, max 1000). Counts cover the whole plan."
        }
      }
    }
  },
  {
    "name": "list_no_receipt_categories",
    "description": "List categories for transactions that don't need receipts",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "assign_no_receipt_category",
    "description": "Assign a no-receipt category to a transaction",
    "inputSchema": {
      "type": "object",
      "properties": {
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        },
        "categoryId": {
          "type": "string",
          "description": "The category ID"
        }
      },
      "required": [
        "transactionId",
        "categoryId"
      ]
    }
  },
  {
    "name": "remove_no_receipt_category",
    "description": "Remove a no-receipt category from a transaction",
    "inputSchema": {
      "type": "object",
      "properties": {
        "transactionId": {
          "type": "string",
          "description": "The transaction ID"
        }
      },
      "required": [
        "transactionId"
      ]
    }
  },
  {
    "name": "create_invoice",
    "description": "Create a new draft invoice for a customer (partner). Amounts in cents, net (pre-VAT). Returns the new invoiceId and a placeholder DRAFT-XXX number. The real number is allocated when the invoice is issued.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "partnerId": {
          "type": "string",
          "description": "Recipient partner ID"
        },
        "partnerType": {
          "type": "string",
          "enum": [
            "user",
            "global"
          ],
          "description": "Partner scope (default: user)"
        },
        "lineItems": {
          "type": "array",
          "description": "Invoice line items (at least one required to issue)",
          "items": {
            "type": "object",
            "properties": {
              "description": {
                "type": "string",
                "description": "Item description"
              },
              "quantity": {
                "type": "number",
                "description": "Quantity"
              },
              "unitPrice": {
                "type": "number",
                "description": "Unit price in cents, net (pre-VAT)"
              },
              "vatRate": {
                "type": "number",
                "description": "VAT rate in percent (default 20)"
              }
            },
            "required": [
              "description",
              "quantity",
              "unitPrice"
            ]
          }
        },
        "issueDate": {
          "type": "string",
          "description": "ISO date (YYYY-MM-DD). Defaults to today."
        },
        "paymentTerms": {
          "type": "string",
          "description": "Free text e.g. 'Payable within 30 days'"
        },
        "currency": {
          "type": "string",
          "description": "ISO 4217 (default EUR)"
        },
        "notes": {
          "type": "string",
          "description": "Free-text footer note"
        },
        "issuerEntityId": {
          "type": "string",
          "description": "Identity entity to issue from (default: first/default)"
        },
        "issuerIban": {
          "type": "string",
          "description": "Specific IBAN to use (must belong to the entity)"
        }
      },
      "required": [
        "partnerId"
      ]
    }
  },
  {
    "name": "update_invoice",
    "description": "Patch a draft invoice. Server recomputes totals and due date. Rejected if status is not 'draft'.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "invoiceId": {
          "type": "string",
          "description": "Invoice ID"
        },
        "patch": {
          "type": "object",
          "description": "Fields to update (partial)",
          "properties": {
            "partnerId": {
              "type": "string"
            },
            "partnerType": {
              "type": "string",
              "enum": [
                "user",
                "global"
              ]
            },
            "issuerEntityId": {
              "type": "string"
            },
            "issuerIban": {
              "type": "string"
            },
            "issueDate": {
              "type": "string",
              "description": "ISO date YYYY-MM-DD"
            },
            "paymentTerms": {
              "type": "string"
            },
            "currency": {
              "type": "string"
            },
            "lineItems": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "description": {
                    "type": "string"
                  },
                  "quantity": {
                    "type": "number"
                  },
                  "unitPrice": {
                    "type": "number"
                  },
                  "vatRate": {
                    "type": "number"
                  }
                }
              }
            },
            "notes": {
              "type": "string"
            }
          }
        }
      },
      "required": [
        "invoiceId",
        "patch"
      ]
    }
  },
  {
    "name": "issue_invoice",
    "description": "Issue a draft invoice: allocates real number, renders the PDF, uploads to Storage, creates the linked TaxFile, and triggers the matching pipeline. Optionally creates a public share link.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "invoiceId": {
          "type": "string",
          "description": "Invoice ID"
        },
        "createShareLink": {
          "type": "boolean",
          "description": "If true, generate a public share token"
        }
      },
      "required": [
        "invoiceId"
      ]
    }
  },
  {
    "name": "list_invoices",
    "description": "List invoices with optional filters",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "draft",
            "issued",
            "sent",
            "paid",
            "cancelled"
          ],
          "description": "Filter by status"
        },
        "partnerId": {
          "type": "string",
          "description": "Filter by recipient partner"
        },
        "fromDate": {
          "type": "string",
          "description": "Issue date >= (ISO)"
        },
        "toDate": {
          "type": "string",
          "description": "Issue date <= (ISO)"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 100, max 500)"
        }
      }
    }
  },
  {
    "name": "get_invoice",
    "description": "Get a single invoice with downloadUrl and shareUrl if available",
    "inputSchema": {
      "type": "object",
      "properties": {
        "invoiceId": {
          "type": "string",
          "description": "Invoice ID"
        }
      },
      "required": [
        "invoiceId"
      ]
    }
  },
  {
    "name": "duplicate_invoice",
    "description": "Duplicate an existing invoice as a new draft. Resets number, file link, share token, and lifecycle timestamps. issueDate becomes today.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "invoiceId": {
          "type": "string",
          "description": "Source invoice ID"
        }
      },
      "required": [
        "invoiceId"
      ]
    }
  },
  {
    "name": "cancel_invoice",
    "description": "Cancel an issued/sent/paid invoice. Sets status to 'cancelled' and soft-deletes the linked file.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "invoiceId": {
          "type": "string",
          "description": "Invoice ID"
        }
      },
      "required": [
        "invoiceId"
      ]
    }
  },
  {
    "name": "get_automation_status",
    "description": "Get user's automation mode, AI budget, and plan info",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  }
];

export const TOOL_NAMES: string[] = TOOL_DEFINITIONS.map((t) => t.name);
