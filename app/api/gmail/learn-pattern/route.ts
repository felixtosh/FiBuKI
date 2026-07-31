export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const PARTNERS_COLLECTION = "partners";

/**
 * POST /api/gmail/learn-pattern
 * Learn an email search pattern for a partner
 *
 * Body: {
 *   partnerId: string;
 *   pattern: string;
 *   integrationId: string;
 *   transactionId?: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { partnerId, pattern, integrationId, transactionId } = body;

    if (!partnerId || !pattern || !integrationId) {
      return NextResponse.json(
        { error: "Missing required fields: partnerId, pattern, integrationId" },
        { status: 400 }
      );
    }

    // Skip empty or very short patterns
    if (pattern.trim().length < 2) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "Pattern too short",
      });
    }

    // Verify the integration belongs to the user
    const integrationSnap = await db
      .collection(INTEGRATIONS_COLLECTION)
      .doc(integrationId)
      .get();

    if (!integrationSnap.exists) {
      return NextResponse.json(
        { error: "Integration not found or unauthorized" },
        { status: 404 }
      );
    }

    const integration = integrationSnap.data()!;
    if (integration.userId !== userId) {
      return NextResponse.json(
        { error: "Integration not found or unauthorized" },
        { status: 404 }
      );
    }

    // Add the pattern to the partner
    await addEmailPatternToPartner(userId, partnerId, {
      pattern: pattern.trim(),
      integrationIds: [integrationId],
      confidence: 60,
      sourceTransactionId: transactionId,
    });

    return NextResponse.json({
      success: true,
      message: "Pattern learned successfully",
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Error learning email pattern:", error);

    // Don't fail the request for pattern learning issues
    // This is a non-critical operation
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to learn pattern",
    });
  }
}

interface EmailSearchPattern {
  pattern: string;
  integrationIds: string[];
  confidence: number;
  sourceTransactionId?: string;
  createdAt?: FirebaseFirestore.Timestamp;
  usageCount?: number;
}

/**
 * Add an email search pattern to a partner
 */
async function addEmailPatternToPartner(
  userId: string,
  partnerId: string,
  patternData: EmailSearchPattern
): Promise<void> {
  const partnerRef = db.collection(PARTNERS_COLLECTION).doc(partnerId);
  const partnerSnap = await partnerRef.get();

  if (!partnerSnap.exists) {
    throw new Error("Partner not found");
  }

  const partner = partnerSnap.data()!;
  if (partner.userId !== userId) {
    throw new Error("Partner not found");
  }

  const existingPatterns = (partner.emailSearchPatterns || []) as EmailSearchPattern[];
  const normalizedPattern = patternData.pattern.toLowerCase().trim();

  // Check if this exact pattern already exists
  const existingIndex = existingPatterns.findIndex(
    (p) => p.pattern.toLowerCase().trim() === normalizedPattern
  );

  const now = Timestamp.now();

  if (existingIndex >= 0) {
    // Update existing pattern - increase confidence and merge integrationIds
    const existing = existingPatterns[existingIndex];
    const mergedIntegrationIds = Array.from(
      new Set([...existing.integrationIds, ...patternData.integrationIds])
    );

    existingPatterns[existingIndex] = {
      ...existing,
      integrationIds: mergedIntegrationIds,
      confidence: Math.min(100, (existing.confidence || 60) + 10),
      usageCount: (existing.usageCount || 0) + 1,
    };
  } else {
    // Add new pattern
    existingPatterns.push({
      ...patternData,
      createdAt: now,
      usageCount: 1,
    });
  }

  await partnerRef.update({
    emailSearchPatterns: existingPatterns,
    emailPatternsUpdatedAt: now,
    updatedAt: now,
  });
}
