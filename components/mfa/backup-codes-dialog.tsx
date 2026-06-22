"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { useMfa } from "@/hooks/use-mfa";
import {
  Loader2,
  Copy,
  Check,
  Download,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";

/** Reusable backup codes list with click-to-copy */
export function BackupCodesList({ codes }: { codes: string[] }) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyCode = async (code: string, index: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = code;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-2 p-3 bg-muted rounded-lg">
      {codes.map((code, i) => (
        <button
          key={i}
          onClick={() => copyCode(code, i)}
          className="group relative flex items-center justify-center gap-2 py-2 px-3 rounded-md font-mono text-sm hover:bg-background transition-colors border border-transparent hover:border-border"
          title="Click to copy"
        >
          <span className={copiedIndex === i ? "text-green-600" : ""}>
            {code}
          </span>
          {copiedIndex === i ? (
            <Check className="h-3 w-3 text-green-600" />
          ) : (
            <Copy className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity" />
          )}
        </button>
      ))}
    </div>
  );
}

interface BackupCodesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If true, shows regeneration warning */
  isRegenerate?: boolean;
}

export function BackupCodesDialog({
  open,
  onOpenChange,
  isRegenerate = false,
}: BackupCodesDialogProps) {
  const { generateBackupCodes, actionLoading, backupCodesRemaining } = useMfa();

  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [showWarning, setShowWarning] = useState(isRegenerate);

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setCodes(null);
      setError(null);
      setCopied(false);
      setAcknowledged(false);
      setShowWarning(isRegenerate);
    });
  }, [open, isRegenerate]);

  const handleGenerate = async () => {
    setError(null);
    setCopied(false);

    try {
      const newCodes = await generateBackupCodes();
      setCodes(newCodes);
      setShowWarning(false);
    } catch (err) {
      console.error("Error generating backup codes:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to generate backup codes. Please try again."
      );
    }
  };

  const copyToClipboard = async () => {
    if (!codes) return;

    const text = codes.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadCodes = () => {
    if (!codes) return;

    const content = `FiBuKI Backup Codes
Generated: ${new Date().toLocaleString()}

${codes.map((code, i) => `${i + 1}. ${code}`).join("\n")}

Keep these codes safe! Each code can only be used once.
`;

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fibuki-backup-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {isRegenerate ? "Regenerate Backup Codes" : "Backup Codes"}
          </DialogTitle>
          <DialogDescription>
            {showWarning
              ? "This will invalidate your current backup codes."
              : "Use these codes if you lose access to your authenticator."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {showWarning && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Warning:</strong> Generating new backup codes will
                invalidate all {backupCodesRemaining} existing codes. Make sure
                you&apos;re ready to save the new codes.
              </AlertDescription>
            </Alert>

            <div className="flex items-start space-x-2">
              <Checkbox
                id="confirm-regenerate"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <label
                htmlFor="confirm-regenerate"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                I understand that my current backup codes will be invalidated
              </label>
            </div>
          </div>
        )}

        {!showWarning && !codes && (
          <div className="py-8 text-center">
            <Button onClick={handleGenerate} disabled={actionLoading}>
              {actionLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                "Generate Backup Codes"
              )}
            </Button>
          </div>
        )}

        {codes && (
          <div className="space-y-4">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Save these codes now!</strong> They will not be shown
                again. Each code can only be used once.
              </AlertDescription>
            </Alert>

            <BackupCodesList codes={codes} />

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={copyToClipboard}
              >
                {copied ? (
                  <>
                    <Check className="mr-2 h-4 w-4 text-green-600" />
                    Copied All!
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy All
                  </>
                )}
              </Button>
              <Button variant="outline" className="flex-1" onClick={downloadCodes}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            </div>

            <div className="flex items-start space-x-2">
              <Checkbox
                id="saved-codes"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <label
                htmlFor="saved-codes"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                I have saved these backup codes in a secure location
              </label>
            </div>
          </div>
        )}

        <DialogFooter>
          {showWarning ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleGenerate}
                disabled={!acknowledged || actionLoading}
              >
                {actionLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  "Regenerate Codes"
                )}
              </Button>
            </>
          ) : codes ? (
            <Button
              onClick={() => onOpenChange(false)}
              disabled={!acknowledged}
              className="w-full"
            >
              Done
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
