"use client";

import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useMfaChallenge, MfaChallengeMethod } from "@/hooks/use-mfa-challenge";
import {
  Loader2,
  AlertCircle,
  Smartphone,
  Fingerprint,
  Key,
  ChevronLeft,
} from "lucide-react";

interface MfaChallengeDialogProps {
  open: boolean;
  onSuccess: () => void;
  onCancel: () => void;
  /** MFA status for custom MFA challenges (passkey-only users) */
  mfaStatus?: import("@/types/mfa").MfaStatusResponse | null;
}

export function MfaChallengeDialog({
  open,
  onSuccess,
  onCancel,
  mfaStatus,
}: MfaChallengeDialogProps) {
  const {
    availableMethods: hookMethods,
    selectedMethod: hookSelectedMethod,
    loading,
    error,
    selectMethod,
    verifyTotp,
    verifyPasskey,
    verifyBackupCode,
    clearChallenge,
  } = useMfaChallenge();

  const [totpCode, setTotpCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [showMethodSelector, setShowMethodSelector] = useState(false);
  const [localSelectedMethod, setLocalSelectedMethod] = useState<MfaChallengeMethod | null>(null);
  const [passkeyAutoTriggered, setPasskeyAutoTriggered] = useState(false);
  const autoTriggerRef = useRef(false);

  // Determine available methods - either from hook (Firebase MFA) or from mfaStatus prop (custom MFA)
  const availableMethods: MfaChallengeMethod[] = (() => {
    // If we have methods from the hook (Firebase MFA flow), use those
    if (hookMethods.length > 0) {
      return hookMethods;
    }
    // Otherwise, derive from mfaStatus prop (custom MFA for passkey-only users)
    if (mfaStatus) {
      const methods: MfaChallengeMethod[] = [];
      if (mfaStatus.passkeysEnabled) methods.push("passkey");
      if (mfaStatus.totpEnabled) methods.push("totp");
      if (mfaStatus.backupCodesRemaining > 0) methods.push("backup_code");
      console.log("[MfaChallengeDialog] Derived methods from mfaStatus:", methods, mfaStatus);
      return methods;
    }
    console.log("[MfaChallengeDialog] No methods available - hookMethods:", hookMethods, "mfaStatus:", mfaStatus);
    return [];
  })();

  // Determine selected method
  const selectedMethod: MfaChallengeMethod | null = (() => {
    // If hook has a selection, use it
    if (hookSelectedMethod) return hookSelectedMethod;
    // If we have a local selection, use it
    if (localSelectedMethod && availableMethods.includes(localSelectedMethod)) {
      return localSelectedMethod;
    }
    // Default to last used method if available, otherwise first available
    if (mfaStatus?.lastMfaMethod && availableMethods.includes(mfaStatus.lastMfaMethod)) {
      return mfaStatus.lastMfaMethod;
    }
    return availableMethods[0] || null;
  })();

  const handlePasskeyVerify = async () => {
    try {
      await verifyPasskey();
      onSuccess();
    } catch (err) {
      // Error is handled by the hook, but we also need to ensure
      // the dialog stays open and user can retry or cancel
      console.log("[MfaChallengeDialog] Passkey verification failed:", err);
    }
  };

  // Auto-trigger passkey verification when dialog opens with passkey selected
  useEffect(() => {
    if (
      open &&
      selectedMethod === "passkey" &&
      !loading &&
      !error &&
      !autoTriggerRef.current &&
      !showMethodSelector
    ) {
      autoTriggerRef.current = true;
      setPasskeyAutoTriggered(true);
      handlePasskeyVerify();
    }
    // Reset when dialog closes
    if (!open) {
      autoTriggerRef.current = false;
      setPasskeyAutoTriggered(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedMethod, loading, showMethodSelector]);

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await verifyTotp(totpCode);
      onSuccess();
    } catch {
      // Error is handled by the hook
    }
  };

  const handleBackupCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await verifyBackupCode(backupCode);
      onSuccess();
    } catch {
      // Error is handled by the hook
    }
  };

  const handleCancel = () => {
    clearChallenge();
    setTotpCode("");
    setBackupCode("");
    setShowMethodSelector(false);
    onCancel();
  };

  const handleSelectMethod = (method: MfaChallengeMethod) => {
    selectMethod(method);
    setLocalSelectedMethod(method);
    setShowMethodSelector(false);
    setTotpCode("");
    setBackupCode("");
  };

  const getMethodIcon = (method: MfaChallengeMethod, size: "sm" | "lg" = "sm") => {
    const className = size === "lg" ? "h-8 w-8" : "h-5 w-5";
    switch (method) {
      case "totp":
        return <Smartphone className={className} />;
      case "passkey":
        return <Fingerprint className={className} />;
      case "backup_code":
        return <Key className={className} />;
    }
  };

  const getMethodLabel = (method: MfaChallengeMethod) => {
    switch (method) {
      case "totp":
        return "Authenticator App";
      case "passkey":
        return "Passkey";
      case "backup_code":
        return "Backup Code";
    }
  };

  const getMethodDescription = (method: MfaChallengeMethod) => {
    switch (method) {
      case "totp":
        return "Use Google Authenticator, Authy, or similar";
      case "passkey":
        return "Use biometrics or security key";
      case "backup_code":
        return "Use one of your recovery codes";
    }
  };

  // Method selector view
  if (showMethodSelector) {
    return (
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !loading && handleCancel()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 -ml-2"
                onClick={() => setShowMethodSelector(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              Choose Verification Method
            </DialogTitle>
            <DialogDescription>
              Select how you want to verify your identity
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            {availableMethods.map((method) => (
              <button
                key={method}
                onClick={() => handleSelectMethod(method)}
                className="w-full flex items-center gap-4 p-4 rounded-lg border hover:bg-accent transition-colors text-left"
              >
                <div className="flex-shrink-0 p-2 rounded-full bg-muted">
                  {getMethodIcon(method, "lg")}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{getMethodLabel(method)}</p>
                  <p className="text-sm text-muted-foreground">
                    {getMethodDescription(method)}
                  </p>
                </div>
              </button>
            ))}
          </div>

          <Button variant="outline" onClick={handleCancel} className="w-full">
            Cancel
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  // Single method verification view
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !loading && handleCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Two-Factor Authentication</DialogTitle>
          <DialogDescription>
            Verify your identity to continue
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* TOTP Verification */}
        {selectedMethod === "totp" && (
          <form onSubmit={handleTotpSubmit} className="space-y-4">
            <div className="text-center py-2">
              <div className="inline-flex p-3 rounded-full bg-muted mb-3">
                <Smartphone className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Enter the 6-digit code from your authenticator app
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="totp-code" className="sr-only">
                Verification Code
              </Label>
              <Input
                id="totp-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={totpCode}
                onChange={(e) =>
                  setTotpCode(e.target.value.replace(/\D/g, ""))
                }
                className="text-center text-2xl tracking-[0.5em] font-mono"
                autoFocus
                disabled={loading}
              />
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                className="flex-1"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={totpCode.length !== 6 || loading}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Verify"
                )}
              </Button>
            </div>

            {availableMethods.length > 1 && (
              <Button
                type="button"
                variant="link"
                className="w-full text-muted-foreground"
                onClick={() => setShowMethodSelector(true)}
              >
                Try another method
              </Button>
            )}
          </form>
        )}

        {/* Passkey Verification */}
        {selectedMethod === "passkey" && (
          <div className="space-y-4">
            <div className="text-center py-4">
              <div className="inline-flex p-4 rounded-full bg-muted mb-4">
                {loading ? (
                  <Loader2 className="h-12 w-12 text-muted-foreground animate-spin" />
                ) : (
                  <Fingerprint className="h-12 w-12 text-muted-foreground" />
                )}
              </div>
              {loading ? (
                <p className="text-sm text-muted-foreground">
                  Waiting for passkey approval&hellip;
                </p>
              ) : error ? (
                <>
                  <p className="text-sm text-muted-foreground mb-2">
                    Verification failed. Please try again.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Use your passkey to verify your identity
                </p>
              )}
            </div>

            {/* Show action buttons only after an error or if not auto-triggering */}
            {(error || !passkeyAutoTriggered || !loading) && !loading && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleCancel}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    autoTriggerRef.current = false;
                    setPasskeyAutoTriggered(false);
                    handlePasskeyVerify();
                  }}
                  className="flex-1"
                >
                  Try Again
                </Button>
              </div>
            )}

            {/* Show cancel only while loading */}
            {loading && (
              <Button
                variant="outline"
                onClick={handleCancel}
                className="w-full"
              >
                Cancel
              </Button>
            )}

            {availableMethods.length > 1 && !loading && (
              <Button
                type="button"
                variant="link"
                className="w-full text-muted-foreground"
                onClick={() => setShowMethodSelector(true)}
              >
                Try another method
              </Button>
            )}
          </div>
        )}

        {/* Backup Code Verification */}
        {selectedMethod === "backup_code" && (
          <form onSubmit={handleBackupCodeSubmit} className="space-y-4">
            <div className="text-center py-2">
              <div className="inline-flex p-3 rounded-full bg-muted mb-3">
                <Key className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Enter one of your backup codes
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="backup-code" className="sr-only">
                Backup Code
              </Label>
              <Input
                id="backup-code"
                type="text"
                placeholder="XXXX-XXXX"
                value={backupCode}
                onChange={(e) =>
                  setBackupCode(e.target.value.toUpperCase())
                }
                className="text-center text-lg tracking-widest font-mono"
                autoFocus
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground text-center">
                Each backup code can only be used once
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                className="flex-1"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={backupCode.length < 8 || loading}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Verify"
                )}
              </Button>
            </div>

            {availableMethods.length > 1 && (
              <Button
                type="button"
                variant="link"
                className="w-full text-muted-foreground"
                onClick={() => setShowMethodSelector(true)}
              >
                Try another method
              </Button>
            )}
          </form>
        )}

        {/* No method available */}
        {!selectedMethod && (
          <div className="text-center py-4">
            <p className="text-muted-foreground">
              No verification method available
            </p>
            <Button variant="outline" onClick={handleCancel} className="mt-4">
              Cancel
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
