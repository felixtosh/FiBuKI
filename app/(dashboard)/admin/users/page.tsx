"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  UserCheck,
  Ban,
  Ticket,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchInput } from "@/components/ui/search-input";
import { ResizableDataTable } from "@/components/ui/data-table/resizable-data-table";
import { ProtectedRoute, useAuth } from "@/components/auth";
import { httpsCallable } from "firebase/functions";
import { functions, db } from "@/lib/firebase/config";
import {
  collection,
  doc,
  query,
  orderBy,
  where,
  onSnapshot,
} from "firebase/firestore";
import { addAllowedEmail, removeAllowedEmail } from "@/lib/operations";
import { AllowedEmail, AccessRequest } from "@/types/auth";
import { callFunction } from "@/lib/firebase/callable";
import { formatDistanceToNow } from "date-fns";
import type { PlanId } from "@/types/billing";
import {
  getUserColumns,
  DEFAULT_USER_COLUMN_SIZES,
  type UserRow,
} from "@/components/admin/user-columns";
import { UserActionBar } from "@/components/admin/user-action-bar";

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

export default function AdminUsersPage() {
  const { userId, isAdmin } = useAuth();
  const [invites, setInvites] = useState<AllowedEmail[]>([]);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [allUsers, setAllUsers] = useState<UserInfo[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [loadingAdmins, setLoadingAdmins] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [togglingAdmin, setTogglingAdmin] = useState<string | null>(null);
  const [settingOverride, setSettingOverride] = useState<string | null>(null);
  const [processingRequest, setProcessingRequest] = useState<string | null>(
    null
  );
  const [openSeatTotal, setOpenSeatTotal] = useState(0);
  const [openSeatRemaining, setOpenSeatRemaining] = useState(0);
  const [openSeatClaimed, setOpenSeatClaimed] = useState(0);
  const [openSeatInput, setOpenSeatInput] = useState("");
  const [savingSeats, setSavingSeats] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Tab state
  const [activeTab, setActiveTab] = useState("management");
  const usersLoadedRef = useRef(false);

  // All Users tab state
  const [userSearch, setUserSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [overrideFilter, setOverrideFilter] = useState<string>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // Listen for open seats config
  useEffect(() => {
    if (!isAdmin) return;

    const unsub = onSnapshot(
      doc(db, "config", "openSeats"),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setOpenSeatTotal(data.totalSeats as number);
          setOpenSeatRemaining(data.remainingSeats as number);
          setOpenSeatClaimed((data.claimedSeats as number) || 0);
        }
      },
      (err) => console.error("openSeats listener error:", err)
    );

    return () => unsub();
  }, [isAdmin]);

  // Load invites from Firestore
  useEffect(() => {
    if (!isAdmin) return;

    const invitesRef = collection(db, "allowedEmails");
    const q = query(invitesRef, orderBy("addedAt", "desc"));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as AllowedEmail[];
        setInvites(data);
        setLoadingInvites(false);
      },
      (err) => {
        console.error("allowedEmails listener error:", err);
        setLoadingInvites(false);
      }
    );

    return () => unsubscribe();
  }, [isAdmin]);

  // Load pending access requests
  useEffect(() => {
    if (!isAdmin) return;

    const requestsRef = collection(db, "accessRequests");
    const q = query(
      requestsRef,
      where("status", "==", "pending"),
      orderBy("requestedAt", "desc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as AccessRequest[];
        setAccessRequests(data);
        setLoadingRequests(false);
      },
      (err) => {
        console.error("accessRequests listener error:", err);
        setLoadingRequests(false);
      }
    );

    return () => unsubscribe();
  }, [isAdmin]);

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

  // Always load admins on mount
  useEffect(() => {
    loadAdmins();
  }, [loadAdmins]);

  // Lazy-load all users only when "All Users" tab is first activated
  useEffect(() => {
    if (activeTab === "users" && !usersLoadedRef.current) {
      usersLoadedRef.current = true;
      loadAllUsers();
    }
  }, [activeTab, loadAllUsers]);

  // Map UserInfo[] to UserRow[] for the data table
  const userRows: UserRow[] = useMemo(
    () =>
      allUsers.map((u) => ({
        ...u,
        id: u.uid,
      })),
    [allUsers]
  );

  // Client-side filtering
  const filteredUsers = useMemo(() => {
    let result = userRows;

    // Text search
    if (userSearch.trim()) {
      const q = userSearch.toLowerCase();
      result = result.filter(
        (u) =>
          u.displayName?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q) ||
          u.uid.toLowerCase().includes(q)
      );
    }

    // Plan filter
    if (planFilter !== "all") {
      result = result.filter((u) => u.plan === planFilter);
    }

    // Role filter
    if (roleFilter !== "all") {
      if (roleFilter === "admin") {
        result = result.filter((u) => u.isAdmin && !u.isSuperAdmin);
      } else if (roleFilter === "superAdmin") {
        result = result.filter((u) => u.isSuperAdmin);
      } else if (roleFilter === "user") {
        result = result.filter((u) => !u.isAdmin);
      }
    }

    // Override filter
    if (overrideFilter !== "all") {
      if (overrideFilter === "none") {
        result = result.filter((u) => !u.adminOverride);
      } else {
        result = result.filter((u) => u.adminOverride === overrideFilter);
      }
    }

    return result;
  }, [userRows, userSearch, planFilter, roleFilter, overrideFilter]);

  const selectedUser = useMemo(
    () => filteredUsers.find((u) => u.id === selectedUserId) ?? null,
    [filteredUsers, selectedUserId]
  );

  const columns = useMemo(() => getUserColumns(), []);

  // Handlers
  const handleInvite = async () => {
    if (!newEmail.trim() || !userId) return;

    setError("");
    setSuccess("");
    setInviting(true);

    try {
      const emailToInvite = newEmail.trim();
      await addAllowedEmail({ db, userId }, emailToInvite);
      callFunction("sendInviteNotification", { email: emailToInvite }).catch(
        () => {}
      );
      setNewEmail("");
      setSuccess(`Invitation sent to ${emailToInvite}`);
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
      setError(
        err instanceof Error ? err.message : "Failed to remove invite"
      );
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
      if (usersLoadedRef.current) await loadAllUsers();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update admin status"
      );
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleMakeAdmin = async (targetUid: string) => {
    setTogglingAdmin(targetUid);
    setError("");
    try {
      const setAdminClaimFn = httpsCallable(functions, "setAdminClaim");
      await setAdminClaimFn({ targetUid, isAdmin: true });
      await Promise.all([loadAdmins(), loadAllUsers()]);
      setSuccess("Admin role granted");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to grant admin role"
      );
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleRemoveAdminFromTable = async (targetUid: string) => {
    setTogglingAdmin(targetUid);
    setError("");
    try {
      const setAdminClaimFn = httpsCallable(functions, "setAdminClaim");
      await setAdminClaimFn({ targetUid, isAdmin: false });
      await Promise.all([loadAdmins(), loadAllUsers()]);
      setSuccess("Admin role removed");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to remove admin role"
      );
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
      setError(
        err instanceof Error ? err.message : "Failed to set override"
      );
    } finally {
      setSettingOverride(null);
    }
  };

  const handleApproveRequest = async (requestId: string) => {
    setProcessingRequest(requestId);
    setError("");
    try {
      await callFunction("approveAccessRequest", { requestId });
      setSuccess("Access request approved");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to approve request"
      );
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleDismissRequest = async (requestId: string) => {
    setProcessingRequest(requestId);
    setError("");
    try {
      await callFunction("dismissAccessRequest", { requestId });
      setSuccess("Access request dismissed");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to dismiss request"
      );
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleSetOpenSeats = async () => {
    const total = parseInt(openSeatInput, 10);
    if (isNaN(total) || total < 0) {
      setError("Enter a valid number of seats");
      return;
    }

    setError("");
    setSavingSeats(true);
    try {
      await callFunction("setOpenSeats", { totalSeats: total });
      setOpenSeatInput("");
      setSuccess(`Open seats updated to ${total}`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update open seats"
      );
    } finally {
      setSavingSeats(false);
    }
  };

  const handleRowClick = (row: UserRow) => {
    setSelectedUserId((prev) => (prev === row.id ? null : row.id));
  };

  // Keyboard: Escape deselects
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedUserId) {
        setSelectedUserId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedUserId]);

  const hasActiveFilters =
    planFilter !== "all" || roleFilter !== "all" || overrideFilter !== "all";

  return (
    <ProtectedRoute requireAdmin>
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="p-6 pb-0">
          <h1 className="text-2xl font-semibold">User Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Invite users, manage admin permissions, and set plan overrides
          </p>
        </div>

        {/* Error/Success Messages */}
        <div className="px-6">
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert className="mt-4">
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col min-h-0 px-6 pt-4"
        >
          <TabsList>
            <TabsTrigger value="management">
              Management
              {accessRequests.length > 0 && (
                <Badge variant="destructive" className="ml-1.5 h-5 px-1.5">
                  {accessRequests.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="users">
              All Users
              {allUsers.length > 0 && (
                <span className="ml-1.5 text-muted-foreground">
                  ({allUsers.length})
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Management Tab */}
          <TabsContent value="management" className="overflow-auto mt-4">
            <div className="max-w-4xl space-y-6 pb-6">
              {/* Open Seats Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Ticket className="h-5 w-5" />
                    Open Seats
                  </CardTitle>
                  <CardDescription>
                    Allow anyone to register without an invite while seats are
                    available
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Input
                        type="number"
                        min="0"
                        placeholder="Total seats"
                        value={openSeatInput}
                        onChange={(e) => setOpenSeatInput(e.target.value)}
                        onKeyDown={(e) =>
                          e.key === "Enter" && handleSetOpenSeats()
                        }
                      />
                    </div>
                    <Button
                      onClick={handleSetOpenSeats}
                      disabled={savingSeats || !openSeatInput}
                    >
                      {savingSeats ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Update"
                      )}
                    </Button>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {openSeatTotal > 0 ? (
                      <span>
                        {openSeatRemaining} of {openSeatTotal} remaining (
                        {openSeatClaimed} claimed)
                      </span>
                    ) : (
                      <span>No open seats configured</span>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Access Requests Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <UserCheck className="h-5 w-5" />
                    Access Requests
                    {accessRequests.length > 0 && (
                      <Badge className="ml-1">{accessRequests.length}</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    Review and approve access requests from new users
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loadingRequests ? (
                    <div className="space-y-2">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  ) : accessRequests.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                      <UserCheck className="h-10 w-10 mx-auto mb-2 opacity-50" />
                      <p>No pending access requests</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {accessRequests.map((req) => (
                        <div
                          key={req.id}
                          className="flex items-center justify-between p-3 border rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            {req.photoURL ? (
                              <img
                                src={req.photoURL}
                                alt=""
                                className="h-8 w-8 rounded-full"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                <Users className="h-4 w-4 text-muted-foreground" />
                              </div>
                            )}
                            <div>
                              <p className="font-medium">
                                {req.displayName || req.email}
                              </p>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                {req.displayName && <span>{req.email}</span>}
                                <Badge
                                  variant="outline"
                                  className="text-xs py-0"
                                >
                                  {req.provider === "github"
                                    ? "GitHub"
                                    : "Google"}
                                </Badge>
                                {req.requestedAt && (
                                  <span>
                                    {formatDistanceToNow(
                                      req.requestedAt.toDate(),
                                      { addSuffix: true }
                                    )}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-green-700 hover:text-green-800"
                              disabled={processingRequest === req.id}
                              onClick={() => handleApproveRequest(req.id)}
                            >
                              {processingRequest === req.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <CheckCircle className="h-4 w-4 mr-1" />
                                  Approve
                                </>
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              disabled={processingRequest === req.id}
                              onClick={() => handleDismissRequest(req.id)}
                            >
                              {processingRequest === req.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <Ban className="h-4 w-4 mr-1" />
                                  Dismiss
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

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
                    <Button
                      onClick={handleInvite}
                      disabled={inviting || !newEmail.trim()}
                    >
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
                              <Badge
                                variant="outline"
                                className="text-green-600"
                              >
                                <CheckCircle className="h-3 w-3 mr-1" />
                                Registered
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-amber-600"
                              >
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
                                    <AlertDialogTitle>
                                      Remove Invite?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This will prevent {invite.email} from
                                      registering.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        handleRemoveInvite(invite)
                                      }
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
                    Users with admin privileges can invite others and manage
                    settings
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
                                    <AlertDialogTitle>
                                      Remove Admin?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {admin.email} will no longer be able to
                                      manage users or access admin settings.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        handleToggleAdmin(admin)
                                      }
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
            </div>
          </TabsContent>

          {/* All Users Tab */}
          <TabsContent
            value="users"
            className="flex-1 flex flex-col min-h-0 mt-4"
          >
            {/* Toolbar */}
            <div className="flex items-center gap-2 mb-3">
              <SearchInput
                value={userSearch}
                onChange={setUserSearch}
                placeholder="Search by name, email, or ID..."
                className="w-64"
              />
              <Select value={planFilter} onValueChange={setPlanFilter}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder="Plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Plans</SelectItem>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="data">Data</SelectItem>
                  <SelectItem value="smart">Smart</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                </SelectContent>
              </Select>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Roles</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="superAdmin">Super Admin</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={overrideFilter}
                onValueChange={setOverrideFilter}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Override" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Overrides</SelectItem>
                  <SelectItem value="none">No Override</SelectItem>
                  <SelectItem value="free_plan">Free Plan</SelectItem>
                  <SelectItem value="plan_tester">Tester</SelectItem>
                </SelectContent>
              </Select>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPlanFilter("all");
                    setRoleFilter("all");
                    setOverrideFilter("all");
                  }}
                >
                  <X className="h-4 w-4 mr-1" />
                  Clear filters
                </Button>
              )}
              <div className="flex-1" />
              <span className="text-sm text-muted-foreground">
                {filteredUsers.length} user{filteredUsers.length !== 1 && "s"}
              </span>
            </div>

            {/* Data Table */}
            <div className="flex-1 min-h-0">
              {loadingUsers ? (
                <div className="space-y-2 p-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <ResizableDataTable
                  columns={columns}
                  data={filteredUsers}
                  defaultColumnSizes={DEFAULT_USER_COLUMN_SIZES}
                  onRowClick={handleRowClick}
                  selectedRowId={selectedUserId}
                  emptyMessage="No users match your filters"
                  autoScrollToSelected={false}
                />
              )}
            </div>

            {/* Action Bar */}
            {selectedUser && (
              <UserActionBar
                user={selectedUser}
                onMakeAdmin={handleMakeAdmin}
                onRemoveAdmin={handleRemoveAdminFromTable}
                onSetOverride={(uid, override) =>
                  handleSetOverride(uid, override)
                }
                loading={
                  togglingAdmin === selectedUser.uid ||
                  settingOverride === selectedUser.uid
                }
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </ProtectedRoute>
  );
}
