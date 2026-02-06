/**
 * Worker Queue Processor
 *
 * Background component that processes pending worker requests concurrently.
 * Runs silently in the background - no UI, just processing.
 */

"use client";

import { useEffect } from "react";
import { useWorkerQueue } from "@/hooks/use-worker-queue";

/**
 * Background worker queue processor.
 * Place this component in the dashboard layout to enable automatic
 * processing of queued worker requests.
 */
export function WorkerQueueProcessor() {
  const { isProcessing, pendingCount } = useWorkerQueue({
    enabled: true,
  });

  useEffect(() => {
    if (isProcessing) {
      console.log(`[WorkerQueueProcessor] Active (${pendingCount} pending)`);
    }
  }, [isProcessing, pendingCount]);

  // This component renders nothing - it just runs the hook
  return null;
}
