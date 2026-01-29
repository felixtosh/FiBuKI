"use client";

import { useState, useMemo } from "react";
import { Loader2, Mail, AlertCircle, Eye, EyeOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/components/auth";
import {
  GoogleAuthProvider,
  linkWithPopup,
  unlink,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import { MfaStatusCard } from "@/components/mfa";

export default function SignInSecurityPage() {
  const { user } = useAuth();
  const [linkingGoogle, setLinkingGoogle] = useState(false);
  const [unlinkingProvider, setUnlinkingProvider] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showPasswordSetup, setShowPasswordSetup] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const providers = useMemo(() => {
    if (!user) return [];
    return user.providerData.map((p) => ({
      id: p.providerId,
      email: p.email,
      displayName: p.displayName,
    }));
  }, [user]);

  const hasGoogle = providers.some((p) => p.id === "google.com");
  const hasPassword = providers.some((p) => p.id === "password");

  const handleLinkGoogle = async () => {
    if (!user) return;
    setAuthError(null);
    setLinkingGoogle(true);
    try {
      await linkWithPopup(user, new GoogleAuthProvider());
    } catch (err: unknown) {
      console.error("Error linking Google:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes("credential-already-in-use")) {
        setAuthError("This Google account is already linked to another user.");
      } else {
        setAuthError("Failed to link Google account. Please try again.");
      }
    } finally {
      setLinkingGoogle(false);
    }
  };

  const handleUnlinkProvider = async (providerId: string) => {
    if (!user) return;
    if (providers.length <= 1) {
      setAuthError("Cannot unlink your only sign-in method.");
      return;
    }
    setAuthError(null);
    setUnlinkingProvider(providerId);
    try {
      await unlink(user, providerId);
    } catch (err) {
      console.error("Error unlinking provider:", err);
      setAuthError("Failed to unlink account. Please try again.");
    } finally {
      setUnlinkingProvider(null);
    }
  };

  const handleSetPassword = async () => {
    if (!user) return;

    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }

    setSettingPassword(true);
    try {
      const setPasswordFn = httpsCallable<{ password: string }, { success: boolean }>(
        functions,
        "setUserPassword"
      );
      await setPasswordFn({ password: newPassword });

      // Password set successfully - reload page to refresh auth state
      // Note: Admin SDK modifications invalidate tokens, so we just reload
      window.location.reload();
    } catch (err: unknown) {
      console.error("Error setting password:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes("already-exists")) {
        setPasswordError("Password is already set.");
      } else {
        setPasswordError("Failed to set password. Please try again.");
      }
      setSettingPassword(false);
    }
  };

  const handleClosePasswordDialog = () => {
    setShowPasswordSetup(false);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
  };

  return (
    <>
      <div className="mb-8">
        <h2 className="text-xl font-semibold">Sign-in & Security</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage how you sign in and protect your account
        </p>
      </div>

      {authError && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{authError}</AlertDescription>
        </Alert>
      )}

      {/* Sign-in Methods Section */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Sign-in Methods</CardTitle>
          <CardDescription>Ways you can sign in to your account</CardDescription>
        </CardHeader>
        <CardContent className="space-y-0">
          {/* Google Provider */}
          <div className="flex items-center justify-between py-4 border-b">
            <div className="flex items-center gap-4">
              <svg className="h-6 w-6" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              <div>
                <p className="font-medium">Google</p>
                <p className="text-sm text-muted-foreground">
                  {hasGoogle
                    ? providers.find((p) => p.id === "google.com")?.email
                    : "Not connected"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {hasGoogle ? (
                <>
                  <span className="text-sm text-green-600">Connected</span>
                  {providers.length > 1 && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={unlinkingProvider === "google.com"}
                        >
                          {unlinkingProvider === "google.com" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Unlink Google Account?</AlertDialogTitle>
                          <AlertDialogDescription>
                            You will no longer be able to sign in with Google.
                            Make sure you have another sign-in method available.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleUnlinkProvider("google.com")}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Unlink
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLinkGoogle}
                  disabled={linkingGoogle}
                >
                  {linkingGoogle && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Connect
                </Button>
              )}
            </div>
          </div>

          {/* Email/Password Provider */}
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-4">
              <Mail className="h-6 w-6 text-muted-foreground" />
              <div>
                <p className="font-medium">Email & Password</p>
                <p className="text-sm text-muted-foreground">
                  {hasPassword ? user?.email : "Not set up"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {hasPassword ? (
                <span className="text-sm text-green-600">Active</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPasswordSetup(true)}
                >
                  Set Password
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Two-Factor Authentication Section */}
      <Card>
        <CardHeader>
          <CardTitle>Two-Factor Authentication</CardTitle>
          <CardDescription>Add an extra layer of security to your account</CardDescription>
        </CardHeader>
        <CardContent>
          <MfaStatusCard showAsSection />
        </CardContent>
      </Card>

      {/* Password Setup Dialog */}
      <Dialog open={showPasswordSetup} onOpenChange={handleClosePasswordDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set Up Password</DialogTitle>
            <DialogDescription>
              Create a password to sign in with email and password in addition to Google.
            </DialogDescription>
          </DialogHeader>

          {passwordError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{passwordError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={user?.email || ""}
                disabled
                className="bg-muted"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  disabled={settingPassword}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                disabled={settingPassword}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleClosePasswordDialog}
              disabled={settingPassword}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSetPassword}
              disabled={settingPassword || !newPassword || !confirmPassword}
            >
              {settingPassword ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Setting Password...
                </>
              ) : (
                "Set Password"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
