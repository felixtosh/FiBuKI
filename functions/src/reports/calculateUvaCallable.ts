/**
 * Cloud Function: calculate the UVA report server-side (fork #64, D4).
 *
 * Replaces the browser-side calculateUVAReport: fetches the period's
 * transactions, their connected files (batch, chunked), and the no-receipt
 * categories, adapts them to plain data and runs the pure calculation
 * module. The web UI calls this endpoint instead of computing locally.
 *
 * The fetch-and-run half lives in uvaPeriodRun so the filing record (#85)
 * derives from the same run rather than from a second copy of it.
 */

import { createCallable } from "../utils/createCallable";
import { runUvaForPeriod } from "./uvaPeriodRun";
import {
  toLegacyReportData,
  type LegacyUvaReportData,
} from "../uva/legacyProjection";
import type { UvaPeriod, UvaReportResult } from "../uva/types";

interface CalculateUvaRequest {
  period: UvaPeriod;
}

interface CalculateUvaResponse {
  success: boolean;
  result: UvaReportResult;
  /** Corrected figures projected onto the legacy shape the preview/PDF render. */
  legacy: LegacyUvaReportData;
}

export const calculateUvaCallable = createCallable<
  CalculateUvaRequest,
  CalculateUvaResponse
>(
  { name: "calculateUva", memory: "512MiB", timeoutSeconds: 120 },
  async (ctx, request) => {
    const { result, stats } = await runUvaForPeriod(
      ctx.db,
      ctx.userId,
      request?.period
    );

    return {
      success: true,
      result,
      legacy: toLegacyReportData(result, stats),
    };
  }
);
