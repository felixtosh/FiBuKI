/**
 * What the browser reads about Fiscal Years from their callables (#794, #805,
 * ADR-0018). The shapes are the server's own, imported as types only (erased
 * at build, so no server code reaches the browser).
 */

import type { UntrackedChoiceChange, UntrackedPreview } from "@/functions/src/fiscalYears/settings";
import type { UntrackedFilesSummary } from "@/functions/src/fiscalYears/untrackedImportCallables";

export type { UntrackedChoiceChange, UntrackedFilesSummary };

/** What previewUntrackedImport answers. */
export type UntrackedImportPreview = UntrackedPreview;

/** The preview's three answers. */
export type UntrackedChoiceKind = "closed" | "open" | "skip";
