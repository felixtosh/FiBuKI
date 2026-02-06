import { useCallback, useEffect, useRef, useState } from "react";
import { callFunction } from "@/lib/firebase/callable";
import { RecordedAction } from "@/types/partner";

export interface LearnModeState {
  /** Whether learn mode is currently active */
  isLearning: boolean;
  /** Recorded actions received so far */
  actions: RecordedAction[];
  /** Number of PDFs detected during learning */
  pdfCount: number;
  /** Current learn run ID (from extension) */
  runId: string | null;
  /** Start learn mode for a partner */
  startLearn: (params: {
    partnerId: string;
    partnerName: string;
    transactionId?: string;
    startUrl?: string;
  }) => void;
  /** Cancel the current learn session */
  cancelLearn: () => void;
  /** Error message if save failed */
  error: string | null;
  /** Whether the recipe is being saved */
  isSaving: boolean;
}

/**
 * Hook managing browser learn mode lifecycle.
 * Communicates with the extension via window.postMessage.
 */
export function useBrowserLearnMode(): LearnModeState {
  const [isLearning, setIsLearning] = useState(false);
  const [actions, setActions] = useState<RecordedAction[]>([]);
  const [pdfCount, setPdfCount] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Track partner info for saving recipe
  const learnParamsRef = useRef<{
    partnerId: string;
    partnerName: string;
    transactionId?: string;
  } | null>(null);

  const startLearn = useCallback(
    (params: {
      partnerId: string;
      partnerName: string;
      transactionId?: string;
      startUrl?: string;
    }) => {
      setIsLearning(true);
      setActions([]);
      setPdfCount(0);
      setRunId(null);
      setError(null);
      learnParamsRef.current = {
        partnerId: params.partnerId,
        partnerName: params.partnerName,
        transactionId: params.transactionId,
      };

      // Tell the extension to start learn mode
      window.postMessage(
        {
          type: "TAXSTUDIO_START_LEARN",
          partnerId: params.partnerId,
          partnerName: params.partnerName,
          transactionId: params.transactionId || null,
          startUrl: params.startUrl || null,
        },
        "*"
      );
    },
    []
  );

  const cancelLearn = useCallback(() => {
    setIsLearning(false);
    setActions([]);
    setPdfCount(0);
    setRunId(null);
    learnParamsRef.current = null;
  }, []);

  // Listen for extension events via window.postMessage
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "TAXSTUDIO_LEARN_STARTED":
          // Extension confirmed learn mode started
          setRunId(data.runId || null);
          break;

        case "TAXSTUDIO_LEARN_ACTION":
          // Real-time action update from extension
          if (data.action) {
            setActions((prev) => [...prev, data.action]);
          }
          break;

        case "TAXSTUDIO_LEARN_PDF":
          // PDF detected during learn mode
          setPdfCount((prev) => prev + 1);
          break;

        case "TAXSTUDIO_LEARN_COMPLETE":
          // Learn mode finished — save recipe
          handleLearnComplete(
            data.actions || [],
            data.pdfCount || 0,
            data.partnerId
          );
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLearnComplete(
    completedActions: RecordedAction[],
    completedPdfCount: number,
    partnerId?: string
  ) {
    const params = learnParamsRef.current;
    if (!params) {
      setIsLearning(false);
      return;
    }

    // Derive startUrl and domain from the first navigate action
    const firstNav = completedActions.find(
      (a) => a.actionType === "navigate" && a.targetUrl
    );
    const startUrl = firstNav?.targetUrl || firstNav?.url || "";
    let domain = "";
    try {
      domain = new URL(startUrl).hostname.replace(/^www\./, "");
    } catch {
      // fallback
    }

    if (!domain || completedActions.length === 0) {
      setError("No actions recorded. Please try again.");
      setIsLearning(false);
      learnParamsRef.current = null;
      return;
    }

    // Detect if auth was required (any action on a login page)
    const requiresAuth = completedActions.some((a) => {
      const url = (a.url || "").toLowerCase();
      return (
        url.includes("/login") ||
        url.includes("/signin") ||
        url.includes("/auth") ||
        url.includes("/oauth") ||
        url.includes("accounts.google.com")
      );
    });

    setIsSaving(true);
    setError(null);

    try {
      await callFunction("saveBrowserRecipe", {
        partnerId: partnerId || params.partnerId,
        startUrl,
        domain,
        recordedActions: completedActions,
        requiresAuth,
        originTransactionId: params.transactionId,
      });
    } catch (err) {
      console.error("Failed to save browser recipe:", err);
      setError(
        err instanceof Error ? err.message : "Failed to save recipe"
      );
    } finally {
      setIsSaving(false);
      setIsLearning(false);
      setActions([]);
      setPdfCount(0);
      setRunId(null);
      learnParamsRef.current = null;
    }
  }

  return {
    isLearning,
    actions,
    pdfCount,
    runId,
    startLearn,
    cancelLearn,
    error,
    isSaving,
  };
}
