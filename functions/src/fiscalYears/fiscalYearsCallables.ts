/**
 * The settings page's Fiscal Years section (#794): read the three values with
 * the latest change records, and change them. The MCP tools get_fiscal_years
 * and set_fiscal_years call the same functions.
 */

import { createCallable } from "../utils/createCallable";
import {
  changeFiscalYears,
  listFiscalYearChanges,
  readFiscalYears,
  type FiscalYearChangeRecord,
  type FiscalYearSettings,
  type FiscalYearsChange,
} from "./fiscalYears";

interface GetFiscalYearsResponse {
  settings: FiscalYearSettings;
  changes: FiscalYearChangeRecord[];
}

interface UpdateFiscalYearsResponse {
  settings: FiscalYearSettings;
  record: FiscalYearChangeRecord | null;
}

export const getFiscalYearsCallable = createCallable<Record<string, never>, GetFiscalYearsResponse>(
  { name: "getFiscalYears" },
  async (ctx) => ({
    settings: await readFiscalYears(ctx.db, ctx.userId),
    changes: await listFiscalYearChanges(ctx.db, ctx.userId),
  })
);

export const updateFiscalYearsCallable = createCallable<FiscalYearsChange, UpdateFiscalYearsResponse>(
  { name: "updateFiscalYears" },
  async (ctx, request) =>
    changeFiscalYears(
      ctx.db,
      ctx.userId,
      {
        startMonth: request?.startMonth,
        trackedFrom: request?.trackedFrom,
        closedThrough: request?.closedThrough,
      },
      "settings"
    )
);
