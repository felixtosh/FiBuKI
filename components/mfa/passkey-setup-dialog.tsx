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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePasskeys } from "@/hooks/use-passkeys";
import { useMfa } from "@/hooks/use-mfa";
import { BackupCodesList } from "./backup-codes-dialog";
import {
  Loader2,
  Check,
  AlertCircle,
  Fingerprint,
  Smartphone,
  Key,
} from "lucide-react";

interface PasskeySetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type SetupStep = "name" | "register" | "success";

export function PasskeySetupDialog({
  open,
  onOpenChange,
  onSuccess,
}: PasskeySetupDialogProps) {
  const { registerPasskey, isSupported, checkPlatformAuthenticator, actionLoading } =
    usePasskeys();
  const { generateBackupCodes, hasBackupCodes } = useMfa();

  const [step, setStep] = useState<SetupStep>("name");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasPlatformAuth, setHasPlatformAuth] = useState<boolean | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  // Check for platform authenticator on mount
  useEffect(() => {
    if (!open) return;
    checkPlatformAuthenticator().then(setHasPlatformAuth);
    queueMicrotask(() => {
      setStep("name");
      setDeviceName("");
      setError(null);
      setBackupCodes(null);
    });
  }, [open, checkPlatformAuthenticator]);

  const handleRegister = async () => {
    setError(null);

    try {
      setStep("register");
      await registerPasskey(deviceName || "Security Key");

      // Generate backup codes if user doesn't have them yet
      if (!hasBackupCodes) {
        const codes = await generateBackupCodes();
        setBackupCodes(codes);
      }

      setStep("success");
    } catch (err) {
      console.error("Passkey registration error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to register passkey. Please try again."
      );
      setStep("name");
    }
  };

  const handleComplete = () => {
    onOpenChange(false);
    onSuccess?.();
  };

  if (!isSupported) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Passkeys Not Supported</DialogTitle>
            <DialogDescription>
              Your browser doesn&apos;t support passkeys. Please use a modern browser
              like Chrome, Safari, or Edge.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5" />
            {step === "success" ? "Passkey Added" : "Add a Passkey"}
          </DialogTitle>
          <DialogDescription>
            {step === "name" &&
              "Use biometrics or a security key to sign in securely without a password."}
            {step === "register" &&
              "Follow your browser's prompts to complete registration."}
            {step === "success" &&
              "Your passkey has been registered successfully."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {step === "name" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center p-4 border rounded-lg bg-muted/50">
                <Fingerprint className="h-8 w-8 mb-2 text-primary" />
                <span className="text-sm font-medium text-center">Touch ID / Face ID</span>
                <span className="text-xs text-muted-foreground">Built-in</span>
              </div>
              <div className="flex flex-col items-center p-4 border rounded-lg bg-muted/50">
                <Key className="h-8 w-8 mb-2 text-primary" />
                <span className="text-sm font-medium text-center">Security Key</span>
                <span className="text-xs text-muted-foreground">YubiKey, etc.</span>
              </div>
              <div className="flex flex-col items-center p-4 border rounded-lg bg-muted/50">
                <Smartphone className="h-8 w-8 mb-2 text-primary" />
                <span className="text-sm font-medium text-center">Phone</span>
                <span className="text-xs text-muted-foreground">Cross-device</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="device-name">Name this passkey (optional)</Label>
              <Input
                id="device-name"
                placeholder="e.g., MacBook Touch ID, YubiKey"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Give it a name to help you identify it later
              </p>
            </div>
          </div>
        )}

        {step === "register" && (
          <div className="flex flex-col items-center py-8 space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground text-center">
              Complete the registration in your browser...
            </p>
          </div>
        )}

        {step === "success" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center py-4">
              <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center">
                <Check className="h-8 w-8 text-green-600" />
              </div>
            </div>

            <p className="text-center text-sm text-muted-foreground">
              <strong>{deviceName || "Security Key"}</strong> has been added to
              your account.
            </p>

            {backupCodes && backupCodes.length > 0 && (
              <>
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Save your backup codes!</strong> These codes can be
                    used if you lose access to your passkeys.
                  </AlertDescription>
                </Alert>

                <BackupCodesList codes={backupCodes} />
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "name" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleRegister} disabled={actionLoading}>
                {actionLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Preparing...
                  </>
                ) : (
                  "Add Passkey"
                )}
              </Button>
            </>
          )}

          {step === "register" && (
            <Button variant="outline" onClick={() => setStep("name")}>
              Cancel
            </Button>
          )}

          {step === "success" && (
            <Button onClick={handleComplete} className="w-full">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
