/**
 * Domain Ownership Validation
 *
 * Uses Gemini Flash Lite to validate whether an email sender domain
 * belongs to a specific company. This helps avoid incorrectly learning
 * payment processor domains (stripe.com, paypal.com) as merchant domains.
 */

import { createVertexAI } from "./lookupCompany";
import { logAIUsage } from "../utils/ai-usage-logger";
import { MODELS } from "../utils/models";

export interface DomainValidationResult {
  isOwner: boolean;
  confidence: number;
  reason: string;
}

const VALIDATION_TIMEOUT_MS = 5000;
const MIN_CONFIDENCE_THRESHOLD = 70;

/**
 * Validate whether an email domain belongs to a specific company using Gemini.
 *
 * @param domain - The email sender domain (e.g., "stripe.com")
 * @param companyName - The company name to validate against (e.g., "Mike's Coffee Shop")
 * @param userId - User ID for usage tracking
 * @returns Validation result with isOwner, confidence, and reason
 */
export async function geminiValidateDomainOwnership(
  domain: string,
  companyName: string,
  userId: string
): Promise<DomainValidationResult> {
  const vertexAI = createVertexAI();
  const modelName = MODELS.geminiLite;

  const model = vertexAI.getGenerativeModel({
    model: modelName,
  });

  const prompt = `You are validating whether an email domain belongs to a specific company.

Company name: "${companyName}"
Email sender domain: "${domain}"

IMPORTANT: Payment processors and billing platforms send emails ON BEHALF OF merchants.
These domains do NOT belong to the merchant:
- stripe.com, paypal.com, square.com, gocardless.com
- braintree.com, adyen.com, mollie.com, klarna.com
- Any domain that is clearly a third-party payment/billing service

Question: Is "${domain}" the company's OWN domain (not a third-party service sending on their behalf)?

Respond with JSON only:
{"isOwner": true/false, "confidence": 0-100, "reason": "brief explanation"}

Examples:
- "amazon.de" for "Amazon EU S.a.r.l." -> {"isOwner": true, "confidence": 95, "reason": "Domain matches company name"}
- "stripe.com" for "Mike's Coffee Shop" -> {"isOwner": false, "confidence": 98, "reason": "Stripe is a payment processor"}
- "receipts.uber.com" for "Uber B.V." -> {"isOwner": true, "confidence": 90, "reason": "Subdomain of Uber"}`;

  try {
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Gemini validation timeout")), VALIDATION_TIMEOUT_MS);
    });

    // Race between API call and timeout
    const result = await Promise.race([
      model.generateContent({
        generationConfig: { responseMimeType: "application/json" },
        contents: [{
          role: "user",
          parts: [{ text: prompt }],
        }],
      }),
      timeoutPromise,
    ]);

    // Log token usage
    const usageMetadata = result.response.usageMetadata;
    if (usageMetadata) {
      await logAIUsage(userId, {
        function: "domainValidation",
        model: modelName,
        inputTokens: usageMetadata.promptTokenCount || 0,
        outputTokens: usageMetadata.candidatesTokenCount || 0,
        metadata: null,
      });
    }

    // Parse response
    const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.log(`[DomainValidation] No JSON in response for "${domain}" / "${companyName}"`);
      return {
        isOwner: false,
        confidence: 0,
        reason: "Failed to parse response",
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as DomainValidationResult;

    // Validate confidence threshold
    if (parsed.confidence < MIN_CONFIDENCE_THRESHOLD) {
      console.log(
        `[DomainValidation] Low confidence (${parsed.confidence}%) for "${domain}" / "${companyName}": ${parsed.reason}`
      );
      return {
        isOwner: false,
        confidence: parsed.confidence,
        reason: `Low confidence: ${parsed.reason}`,
      };
    }

    console.log(
      `[DomainValidation] "${domain}" for "${companyName}": ` +
      `isOwner=${parsed.isOwner}, confidence=${parsed.confidence}%, reason="${parsed.reason}"`
    );

    return parsed;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[DomainValidation] Failed for "${domain}" / "${companyName}":`, errorMessage);

    // Conservative: don't learn domain on error
    return {
      isOwner: false,
      confidence: 0,
      reason: `Validation failed: ${errorMessage}`,
    };
  }
}
