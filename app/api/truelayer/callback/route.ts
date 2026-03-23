export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, collection, addDoc, Timestamp } from "firebase/firestore";
import { getTrueLayerClient } from "@/lib/truelayer";
import { TrueLayerConnection } from "@/types/truelayer";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";

// Initialize Firebase for server-side
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDhxXMbHgaD1z9n0bkuVaSRmmiCrbNL-l4",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "taxstudio-f12fb.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "taxstudio-f12fb.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "534848611676",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:534848611676:web:8a3d1ede57c65b7e884d99",
};

const appName = "truelayer-callback";
const app = getApps().find(a => a.name === appName) || initializeApp(firebaseConfig, appName);
const db = getFirestore(app);

// Connect to emulator in development
if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_USE_EMULATORS !== "false") {
  try {
    connectFirestoreEmulator(db, "localhost", 8080);
    console.log("[TrueLayer Callback] Connected to Firestore emulator");
  } catch {
    // Already connected
  }
}

const CONNECTIONS_COLLECTION = "truelayerConnections";

/**
 * POST /api/truelayer/callback
 * OAuth callback from TrueLayer (uses form_post response_mode)
 */
export async function POST(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  try {
    const userId = await getServerUserIdWithFallback(request);
    const formData = await request.formData();
    const code = formData.get("code") as string;
    const state = formData.get("state") as string;
    const error = formData.get("error") as string;

    // Handle errors from TrueLayer
    if (error) {
      const errorDescription = formData.get("error_description") as string;
      const errorMessage = encodeURIComponent(errorDescription || error);
      return NextResponse.redirect(
        new URL(`/sources/connect/error?message=${errorMessage}`, baseUrl)
      );
    }

    if (!code) {
      return NextResponse.redirect(
        new URL("/sources/connect/error?message=Missing%20authorization%20code", baseUrl)
      );
    }

    // Parse state to get provider info and sourceId
    let sourceId: string | null = null;
    let providerId: string = "unknown";
    let providerName: string = "Unknown Bank";
    let providerLogo: string | null = null;

    if (state) {
      try {
        const stateData = JSON.parse(Buffer.from(state, "base64url").toString());
        sourceId = stateData.sourceId;
        providerId = stateData.providerId || "unknown";
        providerName = stateData.providerName || "Unknown Bank";
        providerLogo = stateData.providerLogo || null;
      } catch {
        // Ignore state parsing errors
      }
    }

    // Exchange code for tokens
    const client = getTrueLayerClient();
    const tokens = await client.exchangeCode(code);

    // Get accounts
    const accounts = await client.getAccounts(tokens.access_token);
    const accountIds = accounts.map(a => a.account_id);

    // Calculate token expiration
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Store connection in Firestore
    const connectionDoc: Omit<TrueLayerConnection, "id"> = {
      providerId,
      providerName,
      providerLogo,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Timestamp.fromDate(expiresAt),
      accountIds,
      userId,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...(sourceId && { linkToSourceId: sourceId }),
    };

    const docRef = await addDoc(collection(db, CONNECTIONS_COLLECTION), connectionDoc);

    // Redirect to account selection
    const params = new URLSearchParams({ connectionId: docRef.id });
    if (sourceId) {
      params.set("sourceId", sourceId);
    }

    return NextResponse.redirect(
      new URL(`/sources/connect/accounts?${params.toString()}`, baseUrl)
    );
  } catch (err) {
    console.error("Error handling TrueLayer callback:", err);
    const message = encodeURIComponent(
      err instanceof Error ? err.message : "An unexpected error occurred"
    );
    return NextResponse.redirect(
      new URL(`/sources/connect/error?message=${message}`, baseUrl)
    );
  }
}

/**
 * GET /api/truelayer/callback
 * Fallback for GET requests (shouldn't happen with form_post)
 */
export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  // Handle as if it were a POST
  if (error) {
    const errorDescription = request.nextUrl.searchParams.get("error_description");
    const errorMessage = encodeURIComponent(errorDescription || error);
    return NextResponse.redirect(
      new URL(`/sources/connect/error?message=${errorMessage}`, baseUrl)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/sources/connect/error?message=Missing%20authorization%20code", baseUrl)
    );
  }

  // For GET requests, redirect to an intermediate page that will handle the flow
  const params = new URLSearchParams({ code });
  if (state) params.set("state", state);

  return NextResponse.redirect(
    new URL(`/sources/connect/processing?${params.toString()}`, baseUrl)
  );
}
