"use client";

import * as React from "react";
import { format, isValid } from "date-fns";
import {
  Building2,
  FileText,
  Sparkles,
  Receipt,
  Globe,
  Tag,
  Search,
  Bot,
  FileSearch,
  Mail,
  FolderOpen,
  CheckCircle,
  AlertCircle,
  Clock,
  Play,
  Loader2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Transaction } from "@/types/transaction";
import type { AutomationStep, PipelineId } from "@/types/automation";
import { getPipelineById } from "@/lib/automations";
import type { SearchStrategy } from "@/types/precision-search";

/**
 * Search history entry returned from API
 */
interface SearchHistoryEntry {
  id: string;
  triggeredBy: string;
  status: string;
  strategiesAttempted: SearchStrategy[];
  totalFilesConnected: number;
  automationSource?: SearchStrategy;
  totalGeminiCalls?: number;
  createdAt: { _seconds?: number; seconds?: number };
  completedAt?: { _seconds?: number; seconds?: number };
  attempts: SearchAttemptEntry[];
}

interface SearchAttemptEntry {
  strategy: SearchStrategy;
  candidatesFound: number;
  matchesFound: number;
  fileIdsConnected: string[];
  error?: string;
  searchParams?: {
    query?: string;
    queries?: string[];
    queryReasoning?: string;
    transactionName?: string;
    partnerId?: string;
    amount?: number;
    amountRange?: { min: number; max: number };
    dateRange?: { from: string; to: string };
    integrationIds?: string[];
  };
}

const PRECISION_STRATEGY_ORDER: SearchStrategy[] = [
  "partner_files",
  "amount_files",
  "email_attachment",
  "email_invoice",
];

const STEP_STRATEGY_MAP: Record<string, SearchStrategy[]> = {
  "file-transaction-matching": ["partner_files", "amount_files"],
  "file-gmail-search": ["email_attachment", "email_invoice"],
};

/**
 * Icon name to component mapping
 */
const ICON_MAP: Record<string, LucideIcon> = {
  Building2,
  FileText,
  Sparkles,
  Receipt,
  Globe,
  Tag,
  Search,
  Bot,
  FileSearch,
  Mail,
  FolderOpen,
  CheckCircle,
};

type AutomationOutcome = "match" | "suggestions" | "no_results" | "error" | "skipped" | "pending";

interface AutomationRunResult {
  stepId: string;
  stepName: string;
  outcome: AutomationOutcome;
  details?: string;
  confidence?: number;
  timestamp?: Date;
}

export interface LastRunOutcome {
  stepId: string;
  outcome: AutomationOutcome;
  details?: string;
  timestamp: Date;
}

export type { AutomationOutcome };

interface AutomationHistoryDialogProps {
  open: boolean;
  onClose: () => void;
  transaction: Transaction;
  pipelineId: PipelineId;
  onTriggerStep?: (stepId: string) => Promise<void>;
  isRunning?: string | null; // stepId that's currently running
  lastRunOutcome?: LastRunOutcome | null; // Result of the most recent manual run
}

/**
 * Derive automation results from transaction data
 * Note: Transaction doesn't store which specific automation matched,
 * only the overall result. We infer what we can from available data.
 */
function deriveAutomationResults(
  transaction: Transaction,
  pipelineId: PipelineId
): AutomationRunResult[] {
  const results: AutomationRunResult[] = [];
  const pipeline = getPipelineById(pipelineId);

  if (!pipeline) return results;

  if (pipelineId === "find-partner") {
    const hasPartner = !!transaction.partnerId;
    const matchedBy = transaction.partnerMatchedBy;
    const hasSuggestions = (transaction.partnerSuggestions?.length ?? 0) > 0;

    for (const step of pipeline.steps) {
      let outcome: AutomationOutcome = "pending";
      let details: string | undefined;
      let confidence: number | undefined;

      // Check if this step type produced the match based on suggestion sources
      const suggestionSources = transaction.partnerSuggestions?.map(s => s.source) || [];

      if (step.id === "partner-iban-match") {
        if (hasPartner && suggestionSources.includes("iban")) {
          outcome = "match";
          confidence = 100;
          details = "Matched by IBAN";
        } else if (suggestionSources.includes("iban")) {
          outcome = "suggestions";
          details = "IBAN suggestion available";
        } else {
          outcome = "no_results";
        }
      } else if (step.id === "partner-pattern-match") {
        // Pattern matching - we can't distinguish from other sources
        outcome = hasPartner ? "skipped" : hasSuggestions ? "suggestions" : "no_results";
        if (hasSuggestions && !hasPartner) {
          details = "Part of suggestion pipeline";
        }
      } else if (step.id === "partner-vat-match") {
        if (hasPartner && suggestionSources.includes("vatId")) {
          outcome = "match";
          confidence = 95;
          details = "Matched by VAT ID";
        } else if (suggestionSources.includes("vatId")) {
          outcome = "suggestions";
          details = "VAT ID suggestion available";
        } else {
          outcome = "no_results";
        }
      } else if (step.id === "partner-website-match") {
        if (hasPartner && suggestionSources.includes("website")) {
          outcome = "match";
          confidence = 90;
          details = "Matched by website";
        } else if (suggestionSources.includes("website")) {
          outcome = "suggestions";
          details = "Website suggestion available";
        } else {
          outcome = "no_results";
        }
      } else if (step.id === "partner-alias-match") {
        // Alias matching - no specific tracking
        outcome = hasPartner ? "skipped" : "no_results";
      } else if (step.id === "partner-fuzzy-name-match") {
        if (hasPartner && suggestionSources.includes("name")) {
          outcome = "match";
          confidence = transaction.partnerMatchConfidence ?? undefined;
          details = "Matched by name";
        } else if (suggestionSources.includes("name")) {
          outcome = "suggestions";
          const nameCount = suggestionSources.filter(s => s === "name").length;
          details = `${nameCount} name suggestion(s)`;
        } else {
          outcome = "no_results";
        }
      } else if (step.id === "partner-ai-lookup") {
        if (hasPartner && matchedBy === "auto" && !hasSuggestions) {
          outcome = "match";
          confidence = transaction.partnerMatchConfidence ?? undefined;
          details = "Possibly found via AI lookup";
        } else if (hasPartner) {
          outcome = "skipped";
          details = "Partner already matched";
        } else {
          outcome = "pending";
          details = "Run manually to search";
        }
      }

      results.push({
        stepId: step.id,
        stepName: step.name,
        outcome,
        details,
        confidence,
      });
    }
  } else if (pipelineId === "find-file") {
    const hasFiles = (transaction.fileIds?.length ?? 0) > 0;
    const hasCategory = !!transaction.noReceiptCategoryId;
    const hasCategorySuggestions = (transaction.categorySuggestions?.length ?? 0) > 0;

    for (const step of pipeline.steps) {
      let outcome: AutomationOutcome = "pending";
      let details: string | undefined;
      let confidence: number | undefined;

      if (step.id === "file-transaction-matching") {
        if (hasFiles) {
          outcome = "match";
          details = `${transaction.fileIds!.length} file(s) connected`;
        } else {
          outcome = "no_results";
          details = "No matching files found";
        }
      } else if (step.id === "file-gmail-search") {
        // Gmail search - check if file was connected via search
        if (hasFiles && transaction.fileAutomationSource) {
          outcome = "match";
          details = `Found via ${transaction.fileAutomationSource}`;
        } else {
          outcome = "pending";
          details = "Run manually to search";
        }
      } else if (step.id === "category-partner-match") {
        if (hasFiles) {
          outcome = "skipped";
          details = "Has files attached";
        } else if (hasCategory && transaction.noReceiptCategoryMatchedBy === "auto") {
          outcome = "match";
          confidence = transaction.noReceiptCategoryConfidence ?? undefined;
          details = "Category auto-matched";
        } else {
          outcome = "no_results";
        }
      } else if (step.id === "category-pattern-match") {
        if (hasFiles) {
          outcome = "skipped";
          details = "Has files attached";
        } else if (hasCategory) {
          outcome = "match";
          confidence = transaction.noReceiptCategoryConfidence ?? undefined;
          details = "Category assigned";
        } else if (hasCategorySuggestions) {
          outcome = "suggestions";
          details = `${transaction.categorySuggestions!.length} category suggestions`;
        } else {
          outcome = "no_results";
        }
      }

      results.push({
        stepId: step.id,
        stepName: step.name,
        outcome,
        details,
        confidence,
      });
    }
  }

  return results;
}

function getOutcomeIcon(outcome: AutomationOutcome): LucideIcon {
  switch (outcome) {
    case "match":
      return CheckCircle;
    case "suggestions":
      return Sparkles;
    case "no_results":
      return MinusCircle;
    case "error":
      return XCircle;
    case "skipped":
      return MinusCircle;
    case "pending":
      return Clock;
    default:
      return MinusCircle;
  }
}

function getOutcomeColor(outcome: AutomationOutcome): string {
  switch (outcome) {
    case "match":
      return "text-green-600 dark:text-green-400";
    case "suggestions":
      return "text-amber-600 dark:text-amber-400";
    case "no_results":
      return "text-muted-foreground";
    case "error":
      return "text-red-600 dark:text-red-400";
    case "skipped":
      return "text-muted-foreground/50";
    case "pending":
      return "text-blue-600 dark:text-blue-400";
    default:
      return "text-muted-foreground";
  }
}

function getOutcomeLabel(outcome: AutomationOutcome): string {
  switch (outcome) {
    case "match":
      return "Match";
    case "suggestions":
      return "Suggestions";
    case "no_results":
      return "No results";
    case "error":
      return "Error";
    case "skipped":
      return "Skipped";
    case "pending":
      return "Not run";
    default:
      return "Unknown";
  }
}

function getTimestampSeconds(value?: { _seconds?: number; seconds?: number }) {
  return value?._seconds ?? value?.seconds ?? null;
}

export function AutomationHistoryDialog({
  open,
  onClose,
  transaction,
  pipelineId,
  onTriggerStep,
  isRunning,
  lastRunOutcome,
}: AutomationHistoryDialogProps) {
  const pipeline = React.useMemo(() => getPipelineById(pipelineId), [pipelineId]);

  // Derive results and merge with last run outcome if available
  const results = React.useMemo(() => {
    const derived = deriveAutomationResults(transaction, pipelineId);

    // If we have a recent manual run outcome, update the relevant step
    if (lastRunOutcome) {
      return derived.map((result) => {
        // For the find-file pipeline, all steps run together via precision search
        // So if any step was triggered, show the outcome for all file-related steps
        if (
          pipelineId === "find-file" &&
          (result.stepId === "file-transaction-matching" ||
            result.stepId === "file-gmail-search")
        ) {
          return {
            ...result,
            outcome: lastRunOutcome.outcome,
            details: lastRunOutcome.details,
            timestamp: lastRunOutcome.timestamp,
          };
        }
        return result;
      });
    }

    return derived;
  }, [transaction, pipelineId, lastRunOutcome]);

  const [selectedStepId, setSelectedStepId] = React.useState<string | null>(null);
  const [searchHistory, setSearchHistory] = React.useState<SearchHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [expandedEntryId, setExpandedEntryId] = React.useState<string | null>(null);

  // Fetch search history when dialog opens or after a run completes (for find-file pipeline)
  React.useEffect(() => {
    if (open && pipelineId === "find-file") {
      setHistoryLoading(true);
      fetch(`/api/precision-search/status?transactionId=${transaction.id}`)
        .then((res) => res.json())
        .then((data) => {
          setSearchHistory(data.history || []);
        })
        .catch((err) => {
          console.error("Failed to fetch search history:", err);
          setSearchHistory([]);
        })
        .finally(() => {
          setHistoryLoading(false);
        });
    }
  }, [open, pipelineId, transaction.id, lastRunOutcome]); // Re-fetch when lastRunOutcome changes

  // Reset selection when dialog opens
  React.useEffect(() => {
    if (open) {
      setSelectedStepId(null);
      setExpandedEntryId(null);
    }
  }, [open]);

  const filteredSearchHistory = React.useMemo(() => {
    if (pipelineId !== "find-file") return [];
    const selectedStrategies = selectedStepId
      ? STEP_STRATEGY_MAP[selectedStepId] ?? []
      : null;
    if (selectedStrategies === null) {
      return searchHistory;
    }
    if (selectedStrategies.length === 0) return [];

    return searchHistory
      .map((entry) => {
        const attempts = entry.attempts.filter((attempt) =>
          selectedStrategies.includes(attempt.strategy)
        );
        if (attempts.length === 0) return null;

        const strategiesAttempted = entry.strategiesAttempted.filter((strategy) =>
          selectedStrategies.includes(strategy)
        );

        const sortedAttempts = [...attempts].sort(
          (a, b) =>
            PRECISION_STRATEGY_ORDER.indexOf(a.strategy) -
            PRECISION_STRATEGY_ORDER.indexOf(b.strategy)
        );

        const sortedStrategies = [...strategiesAttempted].sort(
          (a, b) =>
            PRECISION_STRATEGY_ORDER.indexOf(a) -
            PRECISION_STRATEGY_ORDER.indexOf(b)
        );

        return {
          ...entry,
          attempts: sortedAttempts,
          strategiesAttempted: sortedStrategies,
        };
      })
      .filter((entry): entry is SearchHistoryEntry => entry !== null);
  }, [pipelineId, searchHistory, selectedStepId]);

  if (!pipeline) return null;

  const PipelineIcon = ICON_MAP[pipeline.icon] || Sparkles;
  const selectedStep = pipeline.steps.find(s => s.id === selectedStepId);
  const selectedResult = results.find(r => r.stepId === selectedStepId);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-[800px] h-[500px] p-0 gap-0 flex flex-col">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
              <PipelineIcon className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <DialogTitle>Automation History</DialogTitle>
              <DialogDescription className="mt-1">
                {pipeline.name} - Run history and manual triggers
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Content - Split pane */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel - Available automations */}
          <div className="w-[300px] border-r flex flex-col min-h-0">
            <div className="px-4 py-3 border-b bg-muted/30">
              <h3 className="text-sm font-medium">Automations</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Click to view details or run manually
              </p>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {pipeline.steps.map((step, index) => {
                  const result = results.find(r => r.stepId === step.id);
                  const OutcomeIcon = result ? getOutcomeIcon(result.outcome) : MinusCircle;
                  const StepIcon = ICON_MAP[step.icon] || Sparkles;
                  const isSelected = selectedStepId === step.id;
                  const isStepRunning = isRunning === step.id;

                  return (
                    <div
                      key={step.id}
                      className={cn(
                        "flex items-center gap-2 p-2 rounded-lg transition-colors",
                        isSelected
                          ? "bg-accent border border-accent-foreground/20"
                          : "hover:bg-accent/50 border border-transparent"
                      )}
                    >
                      <button
                        onClick={() => setSelectedStepId(step.id)}
                        className="flex-1 flex items-center gap-3 text-left min-w-0"
                      >
                        {/* Order number */}
                        <div className="w-5 h-5 rounded-full bg-muted text-muted-foreground text-xs flex items-center justify-center font-medium flex-shrink-0">
                          {index + 1}
                        </div>

                        {/* Step icon */}
                        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                          <StepIcon className="h-4 w-4 text-muted-foreground" />
                        </div>

                        {/* Step info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">
                              {step.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {isStepRunning ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                                <span className="text-xs text-blue-500">Running...</span>
                              </>
                            ) : result ? (
                              <>
                                <OutcomeIcon
                                  className={cn("h-3 w-3", getOutcomeColor(result.outcome))}
                                />
                                <span
                                  className={cn(
                                    "text-xs",
                                    getOutcomeColor(result.outcome)
                                  )}
                                >
                                  {getOutcomeLabel(result.outcome)}
                                </span>
                                {result.confidence && (
                                  <span className="text-xs text-muted-foreground">
                                    ({result.confidence}%)
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Not run
                              </span>
                            )}
                          </div>
                        </div>
                      </button>

                      {/* Run button */}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 flex-shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTriggerStep?.(step.id);
                        }}
                        disabled={isRunning !== null}
                        title={`Run ${step.name}`}
                      >
                        {isStepRunning ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          {/* Right panel - Step details */}
          <div className="flex-1 flex flex-col min-h-0">
            {selectedStep && selectedResult ? (
              <ScrollArea className="flex-1">
                <div className="p-6 space-y-6">
                  {/* Step header */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                        {(() => {
                          const Icon = ICON_MAP[selectedStep.icon] || Sparkles;
                          return <Icon className="h-6 w-6 text-muted-foreground" />;
                        })()}
                      </div>
                      <div>
                        <h3 className="text-lg font-semibold">{selectedStep.name}</h3>
                        <p className="text-sm text-muted-foreground mt-1">
                          {selectedStep.shortDescription}
                        </p>
                      </div>
                    </div>

                    {/* Run button */}
                    {onTriggerStep && (
                      <Button
                        size="sm"
                        onClick={() => onTriggerStep(selectedStep.id)}
                        disabled={isRunning !== null}
                      >
                        {isRunning === selectedStep.id ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Running...
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 mr-2" />
                            Run
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  <Separator />

                  {/* Match History */}
                  <div>
                    <h4 className="text-sm font-medium mb-3">Match History</h4>

                    {/* Current state indicator */}
                    <div
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-lg border mb-3",
                        selectedResult.outcome === "match"
                          ? "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800"
                          : selectedResult.outcome === "suggestions"
                            ? "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800"
                            : selectedResult.outcome === "error"
                              ? "bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800"
                              : "bg-muted/30 border-border"
                      )}
                    >
                      {(() => {
                        const OutcomeIcon = getOutcomeIcon(selectedResult.outcome);
                        return (
                          <OutcomeIcon
                            className={cn("h-4 w-4", getOutcomeColor(selectedResult.outcome))}
                          />
                        );
                      })()}
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm font-medium", getOutcomeColor(selectedResult.outcome))}>
                          Current: {getOutcomeLabel(selectedResult.outcome)}
                        </p>
                        {selectedResult.details && (
                          <p className="text-xs text-muted-foreground truncate">
                            {selectedResult.details}
                          </p>
                        )}
                      </div>
                      {selectedResult.confidence && (
                        <Badge variant="secondary" className="text-xs">{selectedResult.confidence}%</Badge>
                      )}
                    </div>

                    {/* Search history entries */}
                    {pipelineId === "find-file" && (
                      <div className="space-y-2">
                        {historyLoading ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Loading history...
                          </div>
                        ) : filteredSearchHistory.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2">
                            No search runs recorded yet
                          </p>
                        ) : (
                          filteredSearchHistory.map((entry) => {
                            const isExpanded = expandedEntryId === entry.id;
                            const entrySeconds = getTimestampSeconds(entry.createdAt);
                            const entryDate = entrySeconds
                              ? new Date(entrySeconds * 1000)
                              : null;
                            const entryDateLabel = entryDate && isValid(entryDate)
                              ? format(entryDate, "MMM d, HH:mm")
                              : "Unknown time";

                            return (
                              <div
                                key={entry.id}
                                className="border rounded-lg overflow-hidden"
                              >
                                {/* Entry header */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedEntryId(isExpanded ? null : entry.id)}
                                  className="w-full flex items-center gap-2 p-3 text-left hover:bg-muted/50 transition-colors"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium">
                                        {entryDateLabel}
                                      </span>
                                      <Badge
                                        variant={entry.status === "completed" ? "secondary" : "destructive"}
                                        className="text-xs px-1.5 py-0"
                                      >
                                        {entry.status}
                                      </Badge>
                                      <Badge variant="outline" className="text-xs px-1.5 py-0">
                                        {entry.triggeredBy}
                                      </Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {entry.totalFilesConnected} file(s) connected
                                      {entry.totalGeminiCalls ? ` · ${entry.totalGeminiCalls} AI calls` : ""}
                                    </p>
                                  </div>
                                </button>

                                {/* Expanded details */}
                                {isExpanded && (
                                  <div className="px-3 pb-3 pt-1 border-t bg-muted/20">
                                    <p className="text-xs font-medium text-muted-foreground mb-2">
                                      Strategies attempted: {entry.strategiesAttempted.join(", ")}
                                    </p>

                                    {/* Individual attempts */}
                                    <div className="space-y-2">
                                      {entry.attempts.map((attempt, idx) => (
                                        <div
                                          key={idx}
                                          className={cn(
                                            "p-2 rounded text-xs border",
                                            attempt.error
                                              ? "bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800"
                                              : attempt.matchesFound > 0
                                                ? "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800"
                                                : "bg-muted/30 border-border"
                                          )}
                                        >
                                          <div className="flex items-center gap-2 mb-1">
                                            <span className="font-medium">{attempt.strategy}</span>
                                            {attempt.error ? (
                                              <Badge variant="destructive" className="text-xs px-1 py-0">
                                                Error
                                              </Badge>
                                            ) : (
                                              <span className="text-muted-foreground">
                                                {attempt.candidatesFound} candidates → {attempt.matchesFound} matches
                                              </span>
                                            )}
                                          </div>

                                          {/* Search params (debug info) */}
                                          {(attempt.searchParams?.query ||
                                            attempt.searchParams?.queries?.length ||
                                            attempt.searchParams?.queryReasoning ||
                                            attempt.searchParams?.transactionName ||
                                            attempt.searchParams?.partnerId ||
                                            attempt.searchParams?.amount != null ||
                                            attempt.searchParams?.amountRange ||
                                            attempt.searchParams?.dateRange ||
                                            attempt.searchParams?.integrationIds?.length) && (
                                            <div className="mt-1 space-y-1">
                                              {attempt.searchParams?.transactionName && (
                                                <div className="text-muted-foreground">
                                                  Transaction: {attempt.searchParams.transactionName}
                                                </div>
                                              )}
                                              {attempt.searchParams?.partnerId && (
                                                <div className="text-muted-foreground">
                                                  Partner ID: {attempt.searchParams.partnerId}
                                                </div>
                                              )}
                                              {attempt.searchParams?.amount != null && (
                                                <div className="text-muted-foreground">
                                                  Amount (cents): {attempt.searchParams.amount}
                                                </div>
                                              )}
                                              {attempt.searchParams?.amountRange && (
                                                <div className="text-muted-foreground">
                                                  Amount range: €{(attempt.searchParams.amountRange.min / 100).toFixed(2)} - €{(attempt.searchParams.amountRange.max / 100).toFixed(2)}
                                                </div>
                                              )}
                                              {attempt.searchParams?.dateRange && (
                                                <div className="text-muted-foreground">
                                                  Date range: {attempt.searchParams.dateRange.from} - {attempt.searchParams.dateRange.to}
                                                </div>
                                              )}
                                              {attempt.searchParams?.integrationIds?.length && (
                                                <div className="text-muted-foreground">
                                                  Integrations: {attempt.searchParams.integrationIds.join(", ")}
                                                </div>
                                              )}
                                              {attempt.searchParams?.queryReasoning && (
                                                <div className="text-muted-foreground">
                                                  Reasoning: {attempt.searchParams.queryReasoning}
                                                </div>
                                              )}
                                              {attempt.searchParams?.query && (
                                                <div className="p-1.5 bg-background/50 rounded font-mono text-xs break-all">
                                                  <span className="text-muted-foreground">Query: </span>
                                                  {attempt.searchParams.query}
                                                </div>
                                              )}
                                              {attempt.searchParams?.queries?.length && (
                                                <div className="p-1.5 bg-background/50 rounded font-mono text-xs break-all space-y-1">
                                                  <span className="text-muted-foreground">Queries:</span>
                                                  {attempt.searchParams.queries.map((query, queryIndex) => (
                                                    <div key={`${attempt.strategy}-query-${queryIndex}`}>
                                                      {query}
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          )}

                                          {attempt.error && (
                                            <div className="mt-1 text-red-600 dark:text-red-400">
                                              {attempt.error}
                                            </div>
                                          )}

                                          {attempt.fileIdsConnected.length > 0 && (
                                            <div className="mt-1 text-green-600 dark:text-green-400">
                                              Connected: {attempt.fileIdsConnected.length} file(s)
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>

                  {/* How it works */}
                  <div>
                    <h4 className="text-sm font-medium mb-2">How it works</h4>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {selectedStep.longDescription}
                    </p>
                  </div>

                  {/* Trigger info */}
                  {selectedStep.trigger && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">When it runs</h4>
                      <Badge variant="outline" className="text-xs">
                        <Clock className="h-3 w-3 mr-1" />
                        {selectedStep.trigger === "always"
                          ? "Always (every pipeline run)"
                          : selectedStep.trigger === "if_no_match"
                            ? "Only if no match found"
                            : selectedStep.trigger === "if_integration"
                              ? "Only if integration connected"
                              : "Manual only"}
                      </Badge>
                    </div>
                  )}
                </div>
              </ScrollArea>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Select an automation to view details</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
