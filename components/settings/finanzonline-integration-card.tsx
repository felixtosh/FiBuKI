"use client";

import { useState } from "react";
import {
  FileText,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  Trash2,
  TestTube,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useUserData } from "@/hooks/use-user-data";
import { useAuth } from "@/components/auth/auth-provider";

export function FinanzOnlineIntegrationCard() {
  const { user, isAdmin } = useAuth();
  const { userData } = useUserData();

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Form state
  const [teilnehmerId, setTeilnehmerId] = useState("");
  const [benutzerId, setBenutzerId] = useState("");
  const [pin, setPin] = useState("");

  // Only show for admins while feature is being hardened
  if (!isAdmin) {
    return null;
  }

  const finanzonline = userData?.finanzonline;
  const isConfigured = finanzonline?.isConfigured;
  const connectionStatus = finanzonline?.connectionStatus;

  const getAuthToken = async () => {
    if (!user) return undefined;
    return user.getIdToken();
  };

  const handleSave = async () => {
    setFeedback(null);
    if (!teilnehmerId || !benutzerId || !pin) {
      setFeedback({ type: "error", message: "Please fill in all fields" });
      return;
    }

    setSaving(true);
    try {
      const token = await getAuthToken();
      const response = await fetch("/api/finanzonline/credentials", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ teilnehmerId, benutzerId, pin }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Failed to save credentials");
      }

      setFeedback({ type: "success", message: "FinanzOnline credentials saved" });
      setShowForm(false);
      setTeilnehmerId("");
      setBenutzerId("");
      setPin("");
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to save credentials",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setFeedback(null);
    setTesting(true);
    try {
      const token = await getAuthToken();
      const response = await fetch("/api/finanzonline/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Connection test failed");
      }

      if (result.success) {
        setFeedback({ type: "success", message: "Connection successful! Your credentials are valid." });
      } else {
        setFeedback({ type: "error", message: result.error || "Connection failed" });
      }
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Connection test failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    setFeedback(null);
    setDeleting(true);
    try {
      const token = await getAuthToken();
      const response = await fetch("/api/finanzonline/credentials", {
        method: "DELETE",
        headers: {
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Failed to remove credentials");
      }

      setFeedback({ type: "success", message: "FinanzOnline credentials removed" });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to remove credentials",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
              <FileText className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <CardTitle className="text-lg">FinanzOnline</CardTitle>
              <CardDescription>
                Submit UVA directly to Austrian tax authority
              </CardDescription>
            </div>
          </div>
          {!isConfigured && !showForm && (
            <Button onClick={() => setShowForm(true)}>Configure</Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {feedback && (
          <div
            className={`mb-4 p-3 rounded-md text-sm ${
              feedback.type === "success"
                ? "bg-green-50 text-green-700 border border-green-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}
          >
            <div className="flex items-center gap-2">
              {feedback.type === "success" ? (
                <Check className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              {feedback.message}
            </div>
          </div>
        )}
        {isConfigured && !showForm ? (
          // Connected state
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      Teilnehmer: {finanzonline?.teilnehmerId}
                    </span>
                    {connectionStatus === "valid" ? (
                      <Badge
                        variant="secondary"
                        className="text-xs border-green-500 text-green-600"
                      >
                        <Check className="h-3 w-3 mr-1" />
                        Connected
                      </Badge>
                    ) : connectionStatus === "invalid" ? (
                      <Badge
                        variant="secondary"
                        className="text-xs border-red-500 text-red-600"
                      >
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Invalid
                      </Badge>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="text-xs border-amber-500 text-amber-600"
                      >
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Untested
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    User: {finanzonline?.benutzerId}
                    {finanzonline?.lastError && (
                      <span className="text-red-500 ml-2">
                        Error: {finanzonline.lastError}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testing}
                >
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <TestTube className="h-4 w-4" />
                  )}
                  <span className="ml-2">Test</span>
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowForm(true)}
                >
                  Update
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" disabled={deleting}>
                      {deleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-red-500" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove FinanzOnline?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove your FinanzOnline credentials. You
                        won&apos;t be able to submit UVA directly until you
                        reconfigure.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleDelete}>
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        ) : showForm ? (
          // Configuration form
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <h4 className="font-medium mb-2">Setup Instructions</h4>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                <li>
                  Log in to{" "}
                  <a
                    href="https://finanzonline.bmf.gv.at"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline inline-flex items-center"
                  >
                    FinanzOnline
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                </li>
                <li>Go to Admin &rarr; Benutzer-Einzel</li>
                <li>Create a new user with &quot;Webservice&quot; enabled</li>
                <li>Note your Teilnehmer-ID, Benutzer-ID, and PIN</li>
              </ol>
            </div>

            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="teilnehmerId">Teilnehmer-ID</Label>
                <Input
                  id="teilnehmerId"
                  placeholder="e.g., 123456"
                  value={teilnehmerId}
                  onChange={(e) => setTeilnehmerId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Your company&apos;s participant ID (6-12 characters)
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="benutzerId">Benutzer-ID</Label>
                <Input
                  id="benutzerId"
                  placeholder="e.g., webservice1"
                  value={benutzerId}
                  onChange={(e) => setBenutzerId(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The WebService user ID you created
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="pin">PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  placeholder="Your WebService PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The PIN/password for the WebService user
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowForm(false);
                  setTeilnehmerId("");
                  setBenutzerId("");
                  setPin("");
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Credentials
              </Button>
            </div>
          </div>
        ) : (
          // Not configured, no form shown
          <div className="text-center py-6 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Configure FinanzOnline to submit UVA directly</p>
            <p className="text-xs mt-1">
              Requires a FinanzOnline WebService user
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
