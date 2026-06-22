"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { logoFont } from "@/app/fonts";

type Status = "idle" | "submitting" | "success" | "error";

export default function DeviceAuthPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [keyName, setKeyName] = useState("");

  // Pre-fill from ?code= query param
  useEffect(() => {
    const prefill = searchParams.get("code");
    if (!prefill) return;
    // Defer to microtask so setState runs event-handler-style, not from within the effect body.
    queueMicrotask(() => setCode(prefill.toUpperCase()));
  }, [searchParams]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !user) {
      const codeParam = searchParams.get("code");
      const redirectUrl = codeParam
        ? `/auth/device?code=${encodeURIComponent(codeParam)}`
        : "/auth/device";
      router.push(`/login?redirect=${encodeURIComponent(redirectUrl)}`);
    }
  }, [loading, user, router, searchParams]);

  // Format code as user types: auto-insert dash after 4 chars
  const handleCodeChange = useCallback((value: string) => {
    // Strip everything except alphanumeric
    const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleaned.length <= 4) {
      setCode(cleaned);
    } else {
      setCode(cleaned.slice(0, 4) + "-" + cleaned.slice(4, 8));
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setStatus("submitting");

    try {
      // Get the Firebase auth token
      const token = await user?.getIdToken();
      if (!token) {
        setError("Not authenticated. Please log in again.");
        setStatus("error");
        return;
      }

      const res = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user_code: code }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }

      setKeyName(data.keyName);
      setStatus("success");
    } catch {
      setError("Network error. Please try again.");
      setStatus("error");
    }
  };

  // Show nothing while checking auth
  if (loading || !user) {
    return (
      <div className="flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-4">
          <div className="flex items-center gap-2">
            <FibukiMascot size={32} />
            <span className={cn("font-bold text-2xl", logoFont.className)}>
              FiBuKI
            </span>
          </div>
        </div>
        <CardTitle className="text-2xl">Authorize Device</CardTitle>
        <CardDescription>
          Enter the code shown in your terminal to grant API access
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "success" ? (
          <div className="text-center space-y-4 py-4">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
            <div>
              <p className="font-medium text-lg">Device authorized!</p>
              <p className="text-sm text-muted-foreground mt-1">
                Key &ldquo;{keyName}&rdquo; created successfully.
              </p>
              <p className="text-sm text-muted-foreground mt-3">
                You can close this tab and return to your terminal.
              </p>
            </div>
          </div>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Input
                  type="text"
                  placeholder="XXXX-XXXX"
                  value={code}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  className="text-center text-2xl font-mono tracking-widest h-14"
                  maxLength={9}
                  autoFocus
                  disabled={status === "submitting"}
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={code.replace("-", "").length !== 8 || status === "submitting"}
              >
                {status === "submitting" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Authorizing...
                  </>
                ) : (
                  "Authorize"
                )}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
