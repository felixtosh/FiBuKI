"use strict";
/**
 * List Bank Institutions Callable
 *
 * Lists available financial institutions from finAPI.
 * This callable has access to the finAPI secrets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listBankInstitutionsCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const params_1 = require("firebase-functions/params");
const FINAPI_CLIENT_ID = (0, params_1.defineSecret)("FINAPI_CLIENT_ID");
const FINAPI_CLIENT_SECRET = (0, params_1.defineSecret)("FINAPI_CLIENT_SECRET");
exports.listBankInstitutionsCallable = (0, createCallable_1.createCallable)({
    name: "listBankInstitutions",
    secrets: [FINAPI_CLIENT_ID, FINAPI_CLIENT_SECRET],
}, async (ctx, request) => {
    const { country } = request;
    if (!country) {
        throw new createCallable_1.HttpsError("invalid-argument", "Country code is required");
    }
    const clientId = FINAPI_CLIENT_ID.value();
    const clientSecret = FINAPI_CLIENT_SECRET.value();
    if (!clientId || !clientSecret) {
        throw new createCallable_1.HttpsError("failed-precondition", "finAPI credentials not configured");
    }
    // Get client credentials token from finAPI
    const tokenResponse = await fetch("https://sandbox.finapi.io/api/v2/oauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });
    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error("[listBankInstitutions] Token error:", errorText);
        throw new createCallable_1.HttpsError("unavailable", "Failed to authenticate with finAPI");
    }
    const tokenData = (await tokenResponse.json());
    const accessToken = tokenData.access_token;
    // List banks from finAPI
    const banksUrl = new URL("https://sandbox.finapi.io/api/v2/banks");
    banksUrl.searchParams.set("countryCode", country.toUpperCase());
    banksUrl.searchParams.set("perPage", "500");
    banksUrl.searchParams.set("isSupported", "true");
    const banksResponse = await fetch(banksUrl.toString(), {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });
    if (!banksResponse.ok) {
        const errorText = await banksResponse.text();
        console.error("[listBankInstitutions] Banks error:", errorText);
        throw new createCallable_1.HttpsError("unavailable", "Failed to fetch banks from finAPI");
    }
    const banksData = (await banksResponse.json());
    const institutions = banksData.banks.map((bank) => ({
        id: String(bank.id),
        name: bank.name,
        logo: bank.logo?.url,
        bic: bank.bic,
        countries: [country.toUpperCase()],
        transaction_total_days: "90", // finAPI default
        providerId: "finapi",
    }));
    // Sort by name
    institutions.sort((a, b) => a.name.localeCompare(b.name));
    return {
        institutions,
        provider: "finapi",
    };
});
//# sourceMappingURL=listInstitutions.js.map