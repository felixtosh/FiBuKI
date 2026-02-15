"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useSources } from "@/hooks/use-sources";
import { useRemapping } from "@/hooks/use-remapping";
import { MappingEditor } from "@/components/import/mapping-editor";
import { RemapPreviewComponent } from "@/components/import/remap-preview";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  AlertTriangle,
} from "lucide-react";

interface EditMappingPageProps {
  params: Promise<{ id: string; importId: string }>;
}

export default function EditMappingPage({ params }: EditMappingPageProps) {
  const { id, importId } = use(params);
  const router = useRouter();
  const { sources, loading: sourcesLoading } = useSources();
  const source = sources.find((s) => s.id === id) || null;

  const {
    state,
    updateMapping,
    updateMappingFormat,
    deleteMapping,
    generatePreview,
    applyChanges,
    goBackToMapping,
    clearError,
  } = useRemapping(importId, source);

  // Loading states
  if (sourcesLoading || state.step === "loading") {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error state
  if (state.step === "error") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-destructive text-center max-w-md">{state.error}</p>
        <Button variant="outline" onClick={() => router.push(`/sources/${id}`)}>
          Back to Source
        </Button>
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

  const getStepNumber = () => {
    switch (state.step) {
      case "mapping":
        return 1;
      case "preview":
        return 2;
      case "applying":
      case "complete":
        return 3;
      default:
        return 1;
    }
  };

  return (
    <div className="h-full overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-4 border-b flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push(`/sources/${id}`)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Edit Import Mapping</h1>
          <p className="text-sm text-muted-foreground">
            {source.name} • {state.importRecord?.fileName}
          </p>
        </div>
      </div>

      {/* Steps indicator */}
      <div className="flex items-center gap-2 px-4 py-4 border-b flex-shrink-0">
        <StepIndicator
          step={1}
          label="Edit Mapping"
          isActive={state.step === "mapping"}
          isComplete={getStepNumber() > 1}
        />
        <StepDivider />
        <StepIndicator
          step={2}
          label="Preview Changes"
          isActive={state.step === "preview"}
          isComplete={getStepNumber() > 2}
        />
        <StepDivider />
        <StepIndicator
          step={3}
          label="Apply"
          isActive={state.step === "applying" || state.step === "complete"}
          isComplete={state.step === "complete"}
        />
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto px-4 py-6">
        {/* Error display */}
        {state.error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg text-destructive flex items-center justify-between">
            <span>{state.error}</span>
            <Button variant="ghost" size="sm" onClick={clearError}>
              Dismiss
            </Button>
          </div>
        )}

        {/* Step content */}
        {state.step === "mapping" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{state.importRecord?.fileName}</p>
                <p className="text-sm text-muted-foreground">
                  {state.parsedRows.length} rows • {state.headers.length} columns
                </p>
              </div>
            </div>

            <MappingEditor
              mappings={state.mappings}
              sampleRows={state.parsedRows.slice(0, 10)}
              onMappingChange={updateMapping}
              onFormatChange={updateMappingFormat}
              onMappingDelete={deleteMapping}
            />

            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => router.push(`/sources/${id}`)}
              >
                Cancel
              </Button>
              <Button onClick={generatePreview}>
                Preview Changes
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {state.step === "preview" && state.preview && (
          <div className="flex flex-col h-full -my-6 -mx-4">
            <RemapPreviewComponent preview={state.preview} />

            <div className="flex justify-between sticky bottom-0 bg-background border-t px-4 py-4">
              <Button variant="outline" onClick={goBackToMapping}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Mapping
              </Button>
              <Button
                onClick={applyChanges}
                disabled={state.preview.totalChanges === 0}
              >
                Apply {state.preview.totalChanges} Changes
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {(state.step === "applying" || state.step === "complete") && (
          <Card>
            <CardContent className="pt-6">
              {state.step === "applying" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    <div>
                      <p className="font-medium">Applying changes...</p>
                      <p className="text-sm text-muted-foreground">
                        Updating transactions with new mapping
                      </p>
                    </div>
                  </div>
                  <Progress value={state.progress} />
                </div>
              )}

              {state.step === "complete" && state.results && (
                <div className="space-y-6">
                  <div className="flex items-center gap-4">
                    <CheckCircle2 className="h-8 w-8 text-green-500" />
                    <div>
                      <p className="font-medium text-lg">Remapping Complete</p>
                      <p className="text-muted-foreground">
                        Your transactions have been updated with the new mapping.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-4 bg-muted rounded-lg text-center">
                      <p className="text-2xl font-bold">{state.results.updated}</p>
                      <p className="text-sm text-muted-foreground">Updated</p>
                    </div>
                    <div className="p-4 bg-muted rounded-lg text-center">
                      <p className="text-2xl font-bold">{state.results.skipped}</p>
                      <p className="text-sm text-muted-foreground">Skipped</p>
                    </div>
                    <div className="p-4 bg-muted rounded-lg text-center">
                      <p className="text-2xl font-bold text-destructive">
                        {state.results.errors.length}
                      </p>
                      <p className="text-sm text-muted-foreground">Errors</p>
                    </div>
                  </div>

                  {state.results.errors.length > 0 && (
                    <div className="border rounded-lg p-4 max-h-40 overflow-auto">
                      <p className="font-medium mb-2">Errors:</p>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        {state.results.errors.map((err, i) => (
                          <li key={i}>
                            Row {err.row}: {err.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex justify-center gap-4">
                    <Button
                      variant="outline"
                      onClick={() => router.push(`/sources/${id}`)}
                    >
                      Back to Source
                    </Button>
                    <Button onClick={() => router.push("/transactions")}>
                      View Transactions
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </Button>
                  </div>
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
