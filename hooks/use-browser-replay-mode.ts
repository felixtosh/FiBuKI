import { useCallback, useEffect, useRef, useState } from "react";
import { callFunction } from "@/lib/firebase/callable";
import { BrowserRecipe, ReplayResult } from "@/types/partner";
import { Transaction } from "@/types/transaction";
import { auth } from "@/lib/firebase/config";

export interface ReplayProgress {
  step: number;
  total: number;
  message: string;
}

export interface ReplayModeState {
  isReplaying: boolean;
  progress: ReplayProgress | null;
  error: string | null;
  result: ReplayResult | null;
  startReplay: (params: {
    partnerId: string;
    partnerName: string;
    transactionId: string;
    recipe: BrowserRecipe;
    transaction: Transaction;
  }) => void | Promise<void>;
  cancelReplay: () => void;
}

function deriveGoalFromSnapshot(
  snapshot: Record<string, unknown>
): "navigate_to_invoices" | "find_invoice" | "download_invoice" {
  const pageType = snapshot.pageType as string | undefined;
  switch (pageType) {
    case "overview_dashboard":
      return "navigate_to_invoices";
    case "invoice_detail":
    case "download_area":
      return "download_invoice";
    default:
      return "find_invoice";
  }
}

/**
 * Hook managing browser replay mode lifecycle.
 * Communicates with the extension via window.postMessage.
 */
export function useBrowserReplayMode(): ReplayModeState {
  const [isReplaying, setIsReplaying] = useState(false);
  const [progress, setProgress] = useState<ReplayProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  const replayParamsRef = useRef<{
    partnerId: string;
    transactionId: string;
    recipe: BrowserRecipe;
  } | null>(null);

  const startReplay = useCallback(
    async (params: {
      partnerId: string;
      partnerName: string;
      transactionId: string;
      recipe: BrowserRecipe;
      transaction: Transaction;
    }) => {
      setIsReplaying(true);
      setProgress(null);
      setError(null);
      setResult(null);
      replayParamsRef.current = {
        partnerId: params.partnerId,
        transactionId: params.transactionId,
        recipe: params.recipe,
      };

      // Get Firebase auth token for the extension to use when uploading files
      const idToken = auth.currentUser
        ? await auth.currentUser.getIdToken()
        : null;

      // Tell the extension to start replay mode
      window.postMessage(
        {
          type: "TAXSTUDIO_START_REPLAY",
          authToken: idToken,
          partnerId: params.partnerId,
          partnerName: params.partnerName,
          transactionId: params.transactionId,
          recipe: {
            id: params.recipe.id,
            startUrl: params.recipe.startUrl,
            domain: params.recipe.domain,
            recordedActions: params.recipe.recordedActions,
            agentActions: params.recipe.agentActions || [],
            invoiceTableMeta: params.recipe.invoiceTableMeta || null,
            invoiceListUrl: params.recipe.invoiceListUrl || null,
            requiresAuth: params.recipe.requiresAuth,
            strategy: params.recipe.strategy || null,
          },
          transactionAmount: params.transaction.amount,
          transactionDate: params.transaction.date
            ? new Date(
                typeof params.transaction.date === "object" &&
                  "toDate" in params.transaction.date
                  ? (
                      params.transaction.date as { toDate: () => Date }
                    ).toDate()
                  : params.transaction.date
              ).toISOString()
            : null,
          transactionCurrency: params.transaction.currency || "EUR",
        },
        "*"
      );
    },
    []
  );

  const cancelReplay = useCallback(() => {
    setIsReplaying(false);
    setProgress(null);
    replayParamsRef.current = null;
  }, []);

  // Handle Tier 2 agent: call the replay-agent API and send commands back
  const handleTier2Needed = useCallback(
    async (data: {
      runId: string;
      snapshot: Record<string, unknown>;
      transactionId: string;
      transactionAmount: number;
      transactionDate: string | null;
      transactionCurrency: string;
      partnerName: string;
      failedAtStep: number;
      recipe?: { strategy?: string[] };
    }) => {
      try {
        // Get invoiceTableMeta from current replay params for Tier 2 context
        const currentRecipe = replayParamsRef.current?.recipe;
        const invoiceListMeta = currentRecipe?.invoiceTableMeta
          ? {
              containerSelector: currentRecipe.invoiceTableMeta.containerSelector,
              selectionType: currentRecipe.invoiceTableMeta.selectionType,
              sampleItems: currentRecipe.invoiceTableMeta.sampleItems,
              url: currentRecipe.invoiceListUrl || currentRecipe.invoiceTableMeta.url,
            }
          : undefined;

        const response = await fetch("/api/browser/replay-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageSnapshot: data.snapshot,
            currentUrl: (data.snapshot as { url?: string }).url || "",
            transactionInfo: {
              amount: data.transactionAmount,
              date: data.transactionDate,
              currency: data.transactionCurrency || "EUR",
              partnerName: data.partnerName,
            },
            goal: deriveGoalFromSnapshot(data.snapshot),
            previousActions: [],
            recipeHint: data.recipe?.strategy || [],
            ...(invoiceListMeta ? { invoiceListMeta } : {}),
          }),
        });

        if (!response.ok) {
          console.error("Replay agent API error:", response.status);
          return;
        }

        const result = await response.json();

        if (result.commands && result.commands.length > 0) {
          // Send commands back to the extension
          window.postMessage(
            {
              type: "TAXSTUDIO_REPLAY_TIER2_COMMANDS",
              runId: data.runId,
              commands: result.commands,
              isDone: result.isDone || false,
            },
            "*"
          );

          setProgress({
            step: data.failedAtStep,
            total: 0,
            message: "AI agent: " + (result.reasoning || "executing..."),
          });
        } else {
          console.log("Replay agent returned no commands:", result.reasoning);
        }
      } catch (err) {
        console.error("Tier 2 agent call failed:", err);
      }
    },
    []
  );

  const handleReplayComplete = useCallback(
    async (replayResult: ReplayResult | undefined) => {
      const params = replayParamsRef.current;

      setResult(replayResult || null);
      setIsReplaying(false);
      setProgress(null);

      if (params && replayResult) {
        try {
          await callFunction("updateBrowserRecipe", {
            partnerId: params.partnerId,
            recipeId: params.recipe.id,
            lastReplayResult: {
              status: replayResult.status,
              tier: replayResult.tier,
              durationMs: replayResult.durationMs,
              transactionId: replayResult.transactionId,
              agentIterations: replayResult.agentIterations,
            },
            incrementUseCount: true,
          });
        } catch (err) {
          console.error("Failed to update recipe after replay:", err);
        }
      }

      replayParamsRef.current = null;
    },
    [],
  );

  const handleReplayFailed = useCallback(
    (replayResult: ReplayResult | undefined) => {
      const failResult = replayResult || {
        status: "failed_timeout" as const,
        tier: 1 as const,
        durationMs: 0,
        transactionId: replayParamsRef.current?.transactionId || "",
      };

      setResult(failResult as ReplayResult);
      setError(
        "Replay failed: " +
          (failResult.status === "failed_element"
            ? "Could not find a page element"
            : failResult.status === "failed_match"
            ? "Could not find matching invoice"
            : failResult.status === "failed_auth"
            ? "Login timed out"
            : failResult.status === "failed_download"
            ? "Download not captured"
            : "Replay timed out"),
      );
      setIsReplaying(false);
      setProgress(null);

      const params = replayParamsRef.current;
      if (params) {
        callFunction("updateBrowserRecipe", {
          partnerId: params.partnerId,
          recipeId: params.recipe.id,
          lastReplayResult: {
            status: failResult.status,
            tier: failResult.tier,
            failedAtStep: (failResult as ReplayResult).failedAtStep,
            durationMs: failResult.durationMs,
            transactionId: failResult.transactionId,
          },
        }).catch((err: unknown) => {
          console.error("Failed to update recipe after replay failure:", err);
        });
      }

      replayParamsRef.current = null;
    },
    [],
  );

  // Listen for extension events via window.postMessage
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "TAXSTUDIO_REPLAY_STARTED":
          break;

        case "TAXSTUDIO_REPLAY_PROGRESS":
          setProgress({
            step: data.step || 0,
            total: data.total || 0,
            message: data.message || "",
          });
          break;

        case "TAXSTUDIO_REPLAY_SUCCESS":
          handleReplayComplete(data.result);
          break;

        case "TAXSTUDIO_REPLAY_FAILED":
          handleReplayFailed(data.result);
          break;

        case "TAXSTUDIO_REPLAY_AUTH_REQUIRED":
          setProgress({
            step: 0,
            total: 0,
            message: "Login required — please sign in",
          });
          break;

        case "TAXSTUDIO_REPLAY_ERROR":
          setError(data.error || "Extension not responding");
          setIsReplaying(false);
          replayParamsRef.current = null;
          break;

        case "TAXSTUDIO_REPLAY_PDF_DOWNLOADED":
          setProgress({
            step: 0,
            total: 0,
            message: "Invoice downloaded!",
          });
          break;

        case "TAXSTUDIO_REPLAY_TIER2_NEEDED":
          handleTier2Needed(data);
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleTier2Needed, handleReplayComplete, handleReplayFailed]);

  return {
    isReplaying,
    progress,
    error,
    result,
    startReplay,
    cancelReplay,
  };
}
