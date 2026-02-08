"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Shield,
  ShieldOff,
  Loader2,
  UserPlus,
  Users,
  Mail,
  CheckCircle,
  Clock,
  Gift,
  TestTube,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Alert,
  AlertDescription,
} from "@/components/ui/alert";
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
import { ProtectedRoute, useAuth } from "@/components/auth";
import { httpsCallable } from "firebase/functions";
import { functions, db } from "@/lib/firebase/config";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from "firebase/firestore";
import { addAllowedEmail, removeAllowedEmail } from "@/lib/operations";
import { AllowedEmail } from "@/types/auth";
import { formatDistanceToNow } from "date-fns";
import type { PlanId } from "@/types/billing";


interface Admin {
  uid: string;
  email: string;
  displayName?: string;
  isSuperAdmin: boolean;
}

interface UserInfo {
  uid: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  plan: PlanId;
  adminOverride: "free_plan" | "plan_tester" | null;
  stripeSubscriptionStatus: string;
  transactionCount: number;
  createdAt: string | null;
}

const PLAN_COLORS: Record<PlanId, string> = {
  free: "bg-gray-100 text-gray-700",
  starter: "bg-blue-100 text-blue-700",
  business: "bg-purple-100 text-purple-700",
  pro: "bg-amber-100 text-amber-700",
};

export default function AdminUsersPage() {
  const { userId, isAdmin } = useAuth();
  const [invites, setInvites] = useState<AllowedEmail[]>([]);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [allUsers, setAllUsers] = useState<UserInfo[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [loadingAdmins, setLoadingAdmins] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [togglingAdmin, setTogglingAdmin] = useState<string | null>(null);
  const [settingOverride, setSettingOverride] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Load invites from Firestore
  useEffect(() => {
    const invitesRef = collection(db, "allowedEmails");
    const q = query(invitesRef, orderBy("addedAt", "desc"));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as AllowedEmail[];
      setInvites(data);
      setLoadingInvites(false);
    });

    return () => unsubscribe();
  }, []);

  // Load admins from Cloud Function
  const loadAdmins = useCallback(async () => {
    setLoadingAdmins(true);
    try {
      const listAdminsFn = httpsCallable<void, { admins: Admin[] }>(
        functions,
        "listAdmins"
      );
      const result = await listAdminsFn();
      setAdmins(result.data.admins);
    } catch (err) {
      console.error("Error loading admins:", err);
    } finally {
      setLoadingAdmins(false);
    }
  }, []);

  // Load all users
  const loadAllUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const listAllUsersFn = httpsCallable<void, { users: UserInfo[] }>(
        functions,
        "listAllUsers"
      );
      const result = await listAllUsersFn();
      setAllUsers(result.data.users);
    } catch (err) {
      console.error("Error loading users:", err);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    loadAdmins();
    loadAllUsers();
  }, [loadAdmins, loadAllUsers]);

  const handleInvite = async () => {
    if (!newEmail.trim() || !userId) return;

    setError("");
    setSuccess("");
    setInviting(true);

    try {
      await addAllowedEmail({ db, userId }, newEmail.trim());
      setNewEmail("");
      setSuccess(`Invitation sent to ${newEmail.trim()}`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invite");
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveInvite = async (invite: AllowedEmail) => {
    if (!userId) return;

    setRemoving(invite.id);
    try {
      await removeAllowedEmail({ db, userId }, invite.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove invite");
    } finally {
      setRemoving(null);
    }
  };

  const handleToggleAdmin = async (admin: Admin) => {
    if (admin.isSuperAdmin) return;

    setTogglingAdmin(admin.uid);
    try {
      const setAdminClaimFn = httpsCallable(functions, "setAdminClaim");
      await setAdminClaimFn({
        targetUid: admin.uid,
        isAdmin: false,
      });
      await loadAdmins();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update admin status");
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleSetOverride = async (
    targetUid: string,
    override: "free_plan" | "plan_tester" | null,
    plan?: PlanId
  ) => {
    setSettingOverride(targetUid);
    setError("");
    try {
      const setOverrideFn = httpsCallable(functions, "setUserOverride");
      await setOverrideFn({ targetUid, override, plan });
      await loadAllUsers();
      const label =
        override === "free_plan"
          ? "Free Plan"
          : override === "plan_tester"
            ? `Plan Tester (${plan})`
            : "cleared";
      setSuccess(`Override ${label} set for user`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set override");
    } finally {
      setSettingOverride(null);
    }
  };

  return (
    <ProtectedRoute requireAdmin>
      <div className="h-full overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-semibold">User Management</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Invite users, manage admin permissions, and set plan overrides
            </p>
          </div>

          {/* Error/Success Messages */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          {/* Invite Users Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-5 w-5" />
                Invite Users
              </CardTitle>
              <CardDescription>
                Add email addresses to allow new users to register
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Invite Form */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                  />
                </div>
                <Button onClick={handleInvite} disabled={inviting || !newEmail.trim()}>
                  {inviting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="h-4 w-4 mr-2" />
                      Invite
                    </>
                  )}
                </Button>
              </div>

              {/* Invites List */}
              {loadingInvites ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : invites.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Mail className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>No pending invites</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {invites.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{invite.email}</p>
                          <p className="text-xs text-muted-foreground">
                            Invited{" "}
                            {formatDistanceToNow(invite.addedAt.toDate(), {
                              addSuffix: true,
                            })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {invite.usedAt ? (
                          <Badge variant="outline" className="text-green-600">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Registered
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-600">
                            <Clock className="h-3 w-3 mr-1" />
                            Pending
                          </Badge>
                        )}
                        {!invite.usedAt && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive hover:text-destructive"
                                disabled={removing === invite.id}
                              >
                                {removing === invite.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove Invite?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will prevent {invite.email} from registering.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleRemoveInvite(invite)}
                                  className="bg-destructive text-destructive-foreground"
                                >
                                  Remove
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Manage Admins Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Administrators
              </CardTitle>
              <CardDescription>
                Users with admin privileges can invite others and manage settings
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingAdmins ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : admins.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Users className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>No admins found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {admins.map((admin) => (
                    <div
                      key={admin.uid}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <Shield className="h-4 w-4 text-primary" />
                        <div>
                          <p className="font-medium">
                            {admin.displayName || admin.email}
                          </p>
                          {admin.displayName && (
                            <p className="text-xs text-muted-foreground">
                              {admin.email}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {admin.isSuperAdmin ? (
                          <Badge>Super Admin</Badge>
                        ) : (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                disabled={togglingAdmin === admin.uid}
                              >
                                {togglingAdmin === admin.uid ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <>
                                    <ShieldOff className="h-4 w-4 mr-1" />
                                    Remove Admin
                                  </>
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove Admin?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {admin.email} will no longer be able to manage users
                                  or access admin settings.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleToggleAdmin(admin)}
                                  className="bg-destructive text-destructive-foreground"
                                >
                                  Remove Admin
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* All Users Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                All Users
              </CardTitle>
              <CardDescription>
                View all users and set plan overrides (Free Plan or Plan Tester)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingUsers ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : allUsers.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground">
                  <Users className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>No users found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {allUsers.map((user) => (
                    <div
                      key={user.uid}
                      className="flex items-center justify-between p-3 border rounded-lg gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {user.displayName || user.email || user.uid}
                          </p>
                          {user.displayName && user.email && (
                            <p className="text-xs text-muted-foreground truncate">
                              {user.email}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {/* Plan badge */}
                        <Badge variant="outline" className={PLAN_COLORS[user.plan]}>
                          {user.plan}
                        </Badge>

                        {/* Override badge */}
                        {user.adminOverride === "free_plan" && (
                          <Badge variant="outline" className="bg-green-100 text-green-700">
                            <Gift className="h-3 w-3 mr-1" />
                            Free Plan
                          </Badge>
                        )}
                        {user.adminOverride === "plan_tester" && (
                          <Badge variant="outline" className="bg-blue-100 text-blue-700">
                            <TestTube className="h-3 w-3 mr-1" />
                            Tester
                          </Badge>
                        )}

                        {/* Admin badge */}
                        {user.isAdmin && (
                          <Badge variant="secondary">
                            {user.isSuperAdmin ? "Super Admin" : "Admin"}
                          </Badge>
                        )}

                        {/* Override actions */}
                        {!user.isAdmin && !user.adminOverride && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-green-700 hover:text-green-800 h-8 px-2"
                              disabled={settingOverride === user.uid}
                              onClick={() => handleSetOverride(user.uid, "free_plan")}
                            >
                              {settingOverride === user.uid ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <>
                                  <Gift className="h-3 w-3 mr-1" />
                                  Free
                                </>
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-blue-700 hover:text-blue-800 h-8 px-2"
                              disabled={settingOverride === user.uid}
                              onClick={() => handleSetOverride(user.uid, "plan_tester")}
                            >
                              {settingOverride === user.uid ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <>
                                  <TestTube className="h-3 w-3 mr-1" />
                                  Tester
                                </>
                              )}
                            </Button>
                          </div>
                        )}

                        {!user.isAdmin && user.adminOverride && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive h-8 px-2"
                                disabled={settingOverride === user.uid}
                              >
                                {settingOverride === user.uid ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <>
                                    <X className="h-3 w-3 mr-1" />
                                    Clear
                                  </>
                                )}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Clear Override?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will reset {user.email} to the Free plan with no
                                  special override.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleSetOverride(user.uid, null)}
                                >
                                  Clear Override
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Info */}
          <div className="text-sm text-muted-foreground">
            <p>
              <strong>Super Admin:</strong> felix@i7v6.com has permanent admin access
              and cannot be removed.
            </p>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
