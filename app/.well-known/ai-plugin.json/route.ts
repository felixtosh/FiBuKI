/**
 * ChatGPT Plugin Manifest
 *
 * https://fibuki.com/.well-known/ai-plugin.json
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    schema_version: "v1",
    name_for_human: "FiBuKI Tax Studio",
    name_for_model: "fibuki",
    description_for_human: "Manage your bank transactions, receipts, and tax categorization.",
    description_for_model:
      "FiBuKI is a German tax accounting tool. Use this to help users manage their bank transactions, match receipts to transactions, and categorize expenses. Key concepts: Sources are bank accounts. Transactions come from sources. Files are uploaded receipts/invoices. A transaction is complete when it has a file or a no-receipt category. Amounts are in cents (divide by 100 for display).",
    auth: {
      type: "user_http",
      authorization_type: "bearer",
    },
    api: {
      type: "openapi",
      url: "https://fibuki.com/api/openapi.json",
    },
    logo_url: "https://fibuki.com/icon.png",
    contact_email: "support@fibuki.com",
    legal_info_url: "https://fibuki.com/terms",
  });
}
