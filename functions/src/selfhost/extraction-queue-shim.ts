/**
 * Self-host's `extraction/extractionQueue` (module alias in
 * vitest.selfhost.config.ts): asking for an Extraction writes a job for the
 * extraction worker and returns at once (#603). The worker and the queue's
 * SQL live in extraction-worker.ts.
 */

import type { ExtractionRequest } from "../extraction/extractionQueue";
import { enqueueExtractionJob } from "./extraction-worker";

export type { ExtractionRequest };

export async function enqueueExtraction(request: ExtractionRequest): Promise<void> {
  await enqueueExtractionJob(request);
}
