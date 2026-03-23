export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { VertexAI } from "@google-cloud/vertexai";

const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

interface TransactionInfo {
  name?: string;
  partner?: string | null;
  amount: number;
  date: string;
  partnerId?: string | null;
  reference?: string | null;
  partnerIban?: string | null;
  currency?: string;
}

interface PartnerInfo {
  name: string;
  emailDomains?: string[];
  website?: string;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { transaction, partnerInfo } = body as {
      transaction: TransactionInfo;
      partnerInfo?: PartnerInfo;
    };

    if (!transaction) {
      return NextResponse.json({ error: "Transaction info required" }, { status: 400 });
    }

    const vertexAI = new VertexAI({ project: PROJECT_ID, location: VERTEX_LOCATION });
    const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

    // Build context
    const transactionLines: string[] = [];
    if (transaction.name) transactionLines.push(`- Transaction name: ${transaction.name}`);
    if (transaction.partner) transactionLines.push(`- Partner field: ${transaction.partner}`);
    if (transaction.reference) transactionLines.push(`- Reference: ${transaction.reference}`);

    let partnerContext = "";
    if (partnerInfo) {
      partnerContext = `\nKnown partner: ${partnerInfo.name}`;
      if (partnerInfo.emailDomains?.length) {
        partnerContext += `\nPartner email domain: ${partnerInfo.emailDomains[0]}`;
      }
    }

    const prompt = `Extract simple search keywords to find invoice emails for this bank transaction.

Transaction data:
${transactionLines.join("\n")}
${partnerContext}

Generate 2-4 SIMPLE search queries. Rules:
1. Extract the company/merchant name - clean it from bank prefixes like "PP*", "SQ*", "SEPA", "EC"
2. Queries should be SHORT - just 1-3 words each
3. NO complex Gmail syntax like "OR", "AND", parentheses
4. NO amount or date filters
5. First query: just the clean company name
6. Second query: company name + "rechnung" or "invoice"
7. If partner email domain is known, add ONE query with "from:domain.com"
8. Keep it simple - these are search keywords, not filters

Examples of GOOD queries:
- "amazon"
- "amazon rechnung"
- "netflix"
- "from:netflix.com"

Examples of BAD queries (too complex):
- "amazon (Rechnung OR Invoice OR Receipt)"
- "netflix" AND "€9.99"
- from:*@amazon.de (Rechnung OR Invoice)

Return ONLY valid JSON:
{"queries": ["query1", "query2", ...]}`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const response = result.response;
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ queries: [] });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return NextResponse.json({
      queries: parsed.queries || [],
    });
  } catch (error) {
    console.error("[generate-queries] Error:", error);
    return NextResponse.json({ queries: [] });
  }
}
