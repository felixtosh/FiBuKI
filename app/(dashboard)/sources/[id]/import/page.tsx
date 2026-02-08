"use client";

import { use, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSources } from "@/hooks/use-sources";
import { useImport, ImportStep } from "@/hooks/use-import";
import { useDraftImport } from "@/hooks/use-draft-import";
import { CSVDropzone } from "@/components/import/csv-dropzone";
import { MappingEditor } from "@/components/import/mapping-editor";
import { ImportPreview } from "@/components/import/import-preview";
import { ImportProgress } from "@/components/import/import-progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CSVAnalysis } from "@/types/import";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ImportPageProps {
  params: Promise<{ id: string }>;
}

export default function ImportPage({ params }: ImportPageProps) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { sources, loading: sourcesLoading } = useSources();
  const source = sources.find((s) => s.id === id) || null;

  // Check for draft import ID in URL
  const importIdParam = searchParams.get("importId");

  // Load draft if importId is provided
  const {
    data: draftData,
    isLoading: draftLoading,
    error: draftError,
  } = useDraftImport(importIdParam);

  // Initialize useImport with draft data if available
  const {
    state,
    handleFileAnalyzed,
    updateMapping,
    updateMappingFormat,
    deleteMapping,
    validateForPreview,
    clearError,
    executeImport,
    reset,
  } = useImport(source, {
    initialDraft: draftData?.draft ?? null,
    initialCsvContent: draftData?.csvContent ?? null,
  });

  // Determine effective step from URL or transient state
  const urlStep = searchParams.get("step") as ImportStep | null;

  // If resuming draft, default to mapping step (skip upload)
  const getEffectiveStep = (): ImportStep => {
    if (state.transientStep) return state.transientStep;
    if (urlStep) return urlStep;
    // If we have draft data loaded, skip to mapping
    if (draftData && state.analysis) return "mapping";
    return "upload";
  };

  const effectiveStep = getEffectiveStep();

  // Navigation helpers - include importId in URL if we have one
  const navigateToStep = useCallback(
    (step: ImportStep, draftImportId?: string) => {
      const currentImportId = draftImportId || state.draftImportId || importIdParam;

      if (step === "upload") {
        router.push(`/sources/${id}/import`);
      } else if (currentImportId) {
        router.push(`/sources/${id}/import?importId=${currentImportId}&step=${step}`);
      } else {
        router.push(`/sources/${id}/import?step=${step}`);
      }
    },
    [router, id, state.draftImportId, importIdParam]
  );

  const onFileAnalyzed = useCallback(
    async (analysis: CSVAnalysis, file: File) => {
      const result = await handleFileAnalyzed(analysis, file);
      if (result) {
        // Navigate with the new draft import ID
        navigateToStep("mapping", result.importId);
      }
    },
    [handleFileAnalyzed, navigateToStep]
  );

  const onGoToPreview = useCallback(() => {
    if (validateForPreview()) {
      navigateToStep("preview");
    }
  }, [validateForPreview, navigateToStep]);

  const onGoBackToMapping = useCallback(() => {
    clearError();
    navigateToStep("mapping");
  }, [clearError, navigateToStep]);

  const onReset = useCallback(() => {
    reset();
    // Clear the importId from URL when starting fresh
    router.push(`/sources/${id}/import`);
  }, [reset, router, id]);

  // Loading states
  if (sourcesLoading || (importIdParam && draftLoading)) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!source) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Source not found</p>
        <Button
          variant="link"
          onClick={() => router.push("/sources")}
          className="mt-2"
        >
          Back to sources
        </Button>
      </div>
    );
  }

  // Draft loading error
  if (importIdParam && draftError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-muted-foreground">{draftError}</p>
        <Button onClick={() => router.push(`/sources/${id}/import`)}>
          Start New Import
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-4 border-b flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/sources")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Import Transactions</h1>
          <p className="text-sm text-muted-foreground">
            {source.name} • {source.iban}
          </p>
        </div>
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2 px-4 py-4 border-b flex-shrink-0">
        <StepIndicator
          step={1}
          label="Upload"
          isActive={effectiveStep === "upload"}
          isComplete={effectiveStep !== "upload"}
        />
        <StepDivider />
        <StepIndicator
          step={2}
          label="Map Columns"
          isActive={effectiveStep === "mapping"}
          isComplete={["preview", "importing", "complete"].includes(effectiveStep)}
        />
        <StepDivider />
        <StepIndicator
          step={3}
          label="Preview"
          isActive={effectiveStep === "preview"}
          isComplete={["importing", "complete"].includes(effectiveStep)}
        />
        <StepDivider />
        <StepIndicator
          step={4}
          label="Import"
          isActive={effectiveStep === "importing" || effectiveStep === "complete"}
          isComplete={effectiveStep === "complete"}
        />
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto px-4 py-6">
        {/* Error display */}
        {state.error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive">
            {state.error}
          </div>
        )}

        {/* Step content */}
        {effectiveStep === "upload" && (
          <div className="flex flex-col h-full -my-6 -mx-4">
            {state.isMatching ? (
              <div className="flex flex-col items-center justify-center flex-1">
                <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                <p className="text-muted-foreground">
                  AI is analyzing your columns...
                </p>
              </div>
            ) : (
              <CSVDropzone onFileAnalyzed={onFileAnalyzed} className="flex-1" />
            )}
          </div>
      )}

      {effectiveStep === "mapping" && state.analysis && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">
                {state.fileName || draftData?.draft.fileName || "CSV File"}
              </p>
              <p className="text-sm text-muted-foreground">
                {state.analysis.totalRows} rows • {state.analysis.headers.length}{" "}
                columns
                {draftData?.draft && (
                  <>
                    {" "}
                    • Draft saved{" "}
                    {formatDistanceToNow(draftData.draft.createdAt.toDate(), {
                      addSuffix: true,
                    })}
                  </>
                )}
              </p>
            </div>
            <Button variant="outline" onClick={onReset}>
              Upload Different File
            </Button>
          </div>

          <MappingEditor
            mappings={state.mappings}
            sampleRows={state.analysis.sampleRows}
            onMappingChange={updateMapping}
            onFormatChange={updateMappingFormat}
            onMappingDelete={deleteMapping}
          />

          <div className="flex justify-end">
            <Button onClick={onGoToPreview}>
              Continue to Preview
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {effectiveStep === "preview" && state.analysis && (
        <div className="flex flex-col h-full -my-6 -mx-4">
          <ImportPreview
            rows={state.analysis.sampleRows}
            mappings={state.mappings}
            totalRows={state.analysis.totalRows}
          />

          <div className="flex justify-between sticky bottom-0 bg-background border-t px-4 py-4">
            <Button variant="outline" onClick={onGoBackToMapping}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Mapping
            </Button>
            <Button onClick={executeImport}>
              Import {state.analysis.totalRows} Transactions
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {(effectiveStep === "importing" || effectiveStep === "complete") && (
        <Card>
          <CardContent className="pt-6">
            <ImportProgress
              progress={state.progress}
              results={state.results}
              isComplete={effectiveStep === "complete"}
              currency={source?.currency}
            />

            {effectiveStep === "complete" && (
              <div className="flex justify-center gap-4 mt-8">
                <Button variant="outline" onClick={onReset}>
                  Import More
                </Button>
                <Button onClick={() => router.push("/transactions")}>
                  View Transactions
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}

interface StepIndicatorProps {
  step: number;
  label: string;
  isActive: boolean;
  isComplete: boolean;
}

function StepIndicator({ step, label, isActive, isComplete }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`
          w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
          ${
            isComplete
              ? "bg-primary text-primary-foreground"
              : isActive
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
          }
        `}
      >
        {isComplete ? <CheckCircle2 className="h-4 w-4" /> : step}
      </div>
      <span
        className={`text-sm ${
          isActive || isComplete ? "font-medium" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function StepDivider() {
  return <div className="flex-1 h-px bg-border max-w-[60px]" />;
}
