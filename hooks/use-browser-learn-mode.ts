import { useCallback, useEffect, useRef, useState } from "react";
import { callFunction } from "@/lib/firebase/callable";
import { RecordedAction } from "@/types/partner";
import { auth } from "@/lib/firebase/config";

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
  }) => void | Promise<void>;
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
    async (params: {
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

      // Get Firebase auth token for the extension to use when uploading files
      const idToken = auth.currentUser
        ? await auth.currentUser.getIdToken()
        : null;

      // Tell the extension to start learn mode
      window.postMessage(
        {
          type: "TAXSTUDIO_START_LEARN",
          partnerId: params.partnerId,
          partnerName: params.partnerName,
          transactionId: params.transactionId || null,
          startUrl: params.startUrl || null,
          authToken: idToken,
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
          // Tab was closed — just cancel, don't save
          if (data.tabClosed) {
            setIsLearning(false);
            setActions([]);
            setPdfCount(0);
            setRunId(null);
            learnParamsRef.current = null;
            break;
          }
          // Learn mode finished — save recipe
          handleLearnComplete(
            data.actions || [],
            data.pdfCount || 0,
            data.partnerId,
            data.invoiceListUrl || null
          );
          break;

        case "TAXSTUDIO_LEARN_ERROR":
          // Extension background not responding
          setError(data.error || "Extension not responding");
          setIsLearning(false);
          learnParamsRef.current = null;
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);

  }, []);

  async function handleLearnComplete(
    completedActions: RecordedAction[],
    completedPdfCount: number,
    partnerId?: string,
    invoiceListUrlFromExt?: string | null
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
    // Match hyphenated compounds like /mein-magenta-login/
    const requiresAuth = completedActions.some((a) => {
      const url = (a.url || "").toLowerCase();
      return (
        /[/\-_.]login/i.test(url) ||
        /[/\-_.]log-in/i.test(url) ||
        /[/\-_.]signin/i.test(url) ||
        /[/\-_.]sign-in/i.test(url) ||
        /[/\-_.]anmeld/i.test(url) ||
        url.includes("/auth") ||
        url.includes("/oauth") ||
        url.includes("accounts.google.com")
      );
    });

    // Extract invoice list data from mark_invoice_page or selectInvoice action
    const markAction = completedActions.find(
      (a) => a.actionType === "mark_invoice_page"
    );
    const selectAction = completedActions.find(
      (a) => a.actionType === "selectInvoice"
    );

    // Auto-detect: if no explicit mark, look for a click whose text looks like a date/month.
    // e.g., "Jänner 2026", "February 2025", "01/2026"
    // This works for both page navigations (click → detail page) and JS toggles/accordions
    // (click → same page state change). In both cases, findAndSelectInvoice() will
    // smart-match the correct month during replay, then post-select actions handle download.
    const DATE_CLICK_RE =
      /\b(j[aä]n(?:ner|uar)?|feb(?:ruar)?|m[aä]r(?:z)?|apr(?:il)?|mai|jun[ie]?|jul[ie]?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|nov(?:ember)?|dez(?:ember)?|january|february|march|april|may|june|july|august|september|october|november|december)\b.*\b\d{4}\b|\b\d{1,2}[/.]\d{4}\b|\b\d{4}[-/.]\d{2}\b/i;
    let inferredSelectAction: RecordedAction | null = null;
    if (!markAction && !selectAction) {
      for (const a of completedActions) {
        if (a.actionType !== "click" || !a.clickTarget?.text) continue;
        if (DATE_CLICK_RE.test(a.clickTarget.text)) {
          inferredSelectAction = a;
          break;
        }
      }
    }

    const effectiveSelectAction = selectAction || inferredSelectAction;
    const invoiceListUrl =
      invoiceListUrlFromExt ||
      markAction?.url ||
      effectiveSelectAction?.url ||
      null;
    const snapshot = markAction?.invoiceListSnapshot;

    // If we inferred the select action, retroactively tag it so replay knows
    if (inferredSelectAction && invoiceListUrl) {
      inferredSelectAction.actionType = "selectInvoice";
    }

    // Build invoiceTableMeta from snapshot or inferred data
    let invoiceTableMeta: {
      containerSelector: string;
      rowSelector: string;
      columns: never[];
      url: string;
      selectionType?: string;
      sampleItems?: { text: string; date?: string; amount?: string }[];
    } | undefined;
    if (invoiceListUrl) {
      invoiceTableMeta = {
        containerSelector: snapshot?.containerSelector || "",
        rowSelector: "",
        columns: [],
        url: invoiceListUrl,
        selectionType:
          snapshot?.selectionType ||
          (effectiveSelectAction ? "month" : undefined),
        sampleItems: snapshot?.items?.slice(0, 10),
      };
    }

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
        ...(invoiceListUrl ? { invoiceListUrl } : {}),
        ...(invoiceTableMeta ? { invoiceTableMeta } : {}),
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
