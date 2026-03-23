/**
 * HTTP endpoint for one-click budget warning email unsubscribe (RFC 8058).
 * No auth required — uses HMAC token for verification.
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { verifyUnsubscribeToken } from "../emails/unsubscribeTokens";

export const unsubscribeBudgetWarnings = onRequest(
  {
    region: "europe-west1",
    cors: false,
  },
  async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const uid = (req.query.uid || req.body?.uid) as string;
    const token = (req.query.token || req.body?.token) as string;

    if (!uid || !token) {
      res.status(400).send("Missing parameters");
      return;
    }

    if (!verifyUnsubscribeToken(uid, token, "budgetWarnings")) {
      res.status(403).send("Invalid token");
      return;
    }

    const db = getFirestore();

    await db.collection("subscriptions").doc(uid).set(
      { budgetWarningsEnabled: false, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;display:flex;justify-content:center;align-items:center;min-height:100vh;">
  <div style="text-align:center;max-width:400px;padding:32px;">
    <h1 style="font-size:24px;margin:0 0 12px;">Unsubscribed</h1>
    <p style="color:#6b7280;margin:0 0 24px;">You won&rsquo;t receive budget warning emails from FiBuKI anymore.</p>
    <p style="color:#9ca3af;font-size:14px;">You can re-enable budget warnings anytime in <a href="https://fibuki.com/settings/notifications" style="color:#2563eb;">Settings</a>.</p>
  </div>
</body>
</html>`);
  }
);
