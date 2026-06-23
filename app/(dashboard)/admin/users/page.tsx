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
  Send,
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
import { SearchButton } from "@/components/ui/search-button";
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
import { UserDetailPanel } from "@/components/admin/user-detail-panel";
import { cn } from "@/lib/utils";

const PANEL_WIDTH_KEY = "userDetailPanelWidth";
const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 600;

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
  const [resendingInvite, setResendingInvite] = useState<string | null>(null);
  const [togglingAdmin, setTogglingAdmin] = useState<string | null>(null);
  const [settingOverride, setSettingOverride] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [impersonatingUser, setImpersonatingUser] = useState<string | null>(null);
  const [bulkRescanning, setBulkRescanning] = useState<string | null>(null);
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
  const [perksFilter, setPerksFilter] = useState<string>("all");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // Detail panel
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Load panel width from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(PANEL_WIDTH_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH) {
        setPanelWidth(parsed);
      }
    }
  }, []);

  // Handle resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeRef.current = { startX: e.clientX, startWidth: panelWidth };
    },
    [panelWidth]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startX - e.clientX;
      const newWidth = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, resizeRef.current.startWidth + delta)
      );
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      localStorage.setItem(PANEL_WIDTH_KEY, panelWidth.toString());
      resizeRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, panelWidth]);

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

    if (userSearch.trim()) {
      const q = userSearch.toLowerCase();
      result = result.filter(
        (u) =>
          u.displayName?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q) ||
          u.uid.toLowerCase().includes(q)
      );
    }

    if (planFilter !== "all") {
      result = result.filter((u) => u.plan === planFilter);
    }

    if (roleFilter !== "all") {
      if (roleFilter === "admin") {
        result = result.filter((u) => u.isAdmin && !u.isSuperAdmin);
      } else if (roleFilter === "superAdmin") {
        result = result.filter((u) => u.isSuperAdmin);
      } else if (roleFilter === "user") {
        result = result.filter((u) => !u.isAdmin);
      }
    }

    if (perksFilter !== "all") {
      if (perksFilter === "none") {
        result = result.filter((u) => !u.adminOverride);
      } else {
        result = result.filter((u) => u.adminOverride === perksFilter);
      }
    }

    return result;
  }, [userRows, userSearch, planFilter, roleFilter, perksFilter]);

  const selectedUser = useMemo(
    () => filteredUsers.find((u) => u.id === selectedUserId) ?? null,
    [filteredUsers, selectedUserId]
  );

  const showPanel = activeTab === "users" && !!selectedUser;

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

  const handleResendInvite = async (email: string, inviteId: string) => {
    setResendingInvite(inviteId);
    setError("");
    try {
      await callFunction("sendInviteNotification", { email });
      setSuccess(`Invite resent to ${email}`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to resend invite"
      );
    } finally {
      setResendingInvite(null);
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

  const handleRemoveAdminFromPanel = async (targetUid: string) => {
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
            ? `Tester (${plan})`
            : "cleared";
      setSuccess(`Perk ${label} set for user`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to set perk"
      );
    } finally {
      setSettingOverride(null);
    }
  };

  const handleDeleteUser = async (targetUid: string) => {
    setDeletingUser(targetUid);
    setError("");
    try {
      const adminDeleteUserFn = httpsCallable(functions, "adminDeleteUser");
      await adminDeleteUserFn({ targetUid });
      setSelectedUserId(null);
      await loadAllUsers();
      setSuccess("User account deleted");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete user"
      );
    } finally {
      setDeletingUser(null);
    }
  };

  const handleBulkRescan = async (targetUid: string) => {
    setBulkRescanning(targetUid);
    setError("");
    try {
      const bulkRetryFn = httpsCallable<
        { targetUid: string; maxFiles?: number },
        {
          processed: number;
          succeeded: number;
          failed: number;
          hasMore: boolean;
          sampleErrors: string[];
        }
      >(functions, "bulkRetryExtraction");

      let totalProcessed = 0;
      let totalSucceeded = 0;
      let totalFailed = 0;
      const allErrors: string[] = [];

      // Poll until no more errored files remain (or 10 batches max).
      for (let batch = 0; batch < 10; batch++) {
        const result = await bulkRetryFn({ targetUid });
        totalProcessed += result.data.processed;
        totalSucceeded += result.data.succeeded;
        totalFailed += result.data.failed;
        allErrors.push(...result.data.sampleErrors);
        if (!result.data.hasMore || result.data.processed === 0) break;
      }

      if (totalProcessed === 0) {
        setSuccess("No errored files found for this user");
      } else {
        const errorSnippet =
          totalFailed > 0 && allErrors.length > 0
            ? ` (sample failure: ${allErrors[0].slice(0, 80)})`
            : "";
        setSuccess(
          `Rescanned ${totalProcessed} file(s): ${totalSucceeded} succeeded, ${totalFailed} still failed${errorSnippet}`,
        );
      }
      setTimeout(() => setSuccess(""), 8000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to bulk-rescan files",
      );
    } finally {
      setBulkRescanning(null);
    }
  };

  const handleImpersonate = async (targetUid: string) => {
    setImpersonatingUser(targetUid);
    setError("");
    try {
      const impersonateFn = httpsCallable<
        { targetUid: string },
        { token: string; targetEmail: string | null; adminEmail: string }
      >(functions, "impersonateUser");
      const result = await impersonateFn({ targetUid });
      // Hand the token off to /impersonate via sessionStorage on the new tab.
      // We use a one-shot key so the token never lands in URL/history.
      const payload = JSON.stringify({
        token: result.data.token,
        targetEmail: result.data.targetEmail,
        adminEmail: result.data.adminEmail,
      });
      // sessionStorage is per-tab; we need to pass via a different mechanism.
      // Use the URL fragment (#) — not sent to server, not in history if we
      // immediately replaceState after consuming.
      const url = `/impersonate#${encodeURIComponent(payload)}`;
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to impersonate user",
      );
    } finally {
      setImpersonatingUser(null);
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

  const handleClosePanel = () => {
    setSelectedUserId(null);
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
    planFilter !== "all" || roleFilter !== "all" || perksFilter !== "all";

  return (
    <ProtectedRoute requireAdmin>
      <div className="h-full overflow-hidden">
        {/* Main content - adjusts margin when panel is open */}
        <div
          className="h-full flex flex-col transition-[margin] duration-200 ease-in-out"
          style={{ marginRight: showPanel ? panelWidth : 0 }}
        >
          {/* Error/Success Messages */}
          {(error || success) && (
            <div className="px-4 pt-2">
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
            </div>
          )}

          {/* Tabs */}
          <Tabs
            value={activeTab}
            onValueChange={(v) => {
              setActiveTab(v);
              if (v !== "users") setSelectedUserId(null);
            }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Toolbar row: tabs left, filters right */}
            <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
              <TabsList>
                <TabsTrigger value="management">
                  Management
                  {accessRequests.length > 0 && (
                    <Badge
                      variant="destructive"
                      className="ml-1.5 h-5 px-1.5"
                    >
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

              {/* Filters — only shown on "users" tab */}
              {activeTab === "users" && (
                <>
                  <SearchButton
                    value={userSearch}
                    onSearch={setUserSearch}
                    placeholder="Search by name, email, or ID..."
                  />
                  <Select value={planFilter} onValueChange={setPlanFilter}>
                    <SelectTrigger className="w-[120px] h-9">
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
                    <SelectTrigger className="w-[120px] h-9">
                      <SelectValue placeholder="Role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Roles</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="superAdmin">Super Admin</SelectItem>
                      <SelectItem value="user">User</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={perksFilter} onValueChange={setPerksFilter}>
                    <SelectTrigger className="w-[120px] h-9">
                      <SelectValue placeholder="Perks" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Perks</SelectItem>
                      <SelectItem value="none">No Perk</SelectItem>
                      <SelectItem value="free_plan">Free Plan</SelectItem>
                      <SelectItem value="plan_tester">Tester</SelectItem>
                    </SelectContent>
                  </Select>
                  {hasActiveFilters && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9"
                      onClick={() => {
                        setPlanFilter("all");
                        setRoleFilter("all");
                        setPerksFilter("all");
                      }}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Clear
                    </Button>
                  )}
                  <div className="flex-1" />
                  <span className="text-sm text-muted-foreground">
                    {filteredUsers.length} user
                    {filteredUsers.length !== 1 && "s"}
                  </span>
                </>
              )}
            </div>

            {/* Management Tab */}
            <TabsContent
              value="management"
              className="flex-1 overflow-auto mt-0 p-4"
            >
              <div className="max-w-4xl space-y-6">
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
                        <Badge className="ml-1">
                          {accessRequests.length}
                        </Badge>
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
                                  {req.displayName && (
                                    <span>{req.email}</span>
                                  )}
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
                          onKeyDown={(e) =>
                            e.key === "Enter" && handleInvite()
                          }
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
                                  {formatDistanceToNow(
                                    invite.addedAt.toDate(),
                                    { addSuffix: true }
                                  )}
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
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Resend invite email"
                                  disabled={resendingInvite === invite.id}
                                  onClick={() =>
                                    handleResendInvite(
                                      invite.email,
                                      invite.id
                                    )
                                  }
                                >
                                  {resendingInvite === invite.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Send className="h-4 w-4" />
                                  )}
                                </Button>
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
                                      <AlertDialogCancel>
                                        Cancel
                                      </AlertDialogCancel>
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
                                      <AlertDialogCancel>
                                        Cancel
                                      </AlertDialogCancel>
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
              className="flex-1 overflow-hidden mt-0"
            >
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
            </TabsContent>
          </Tabs>
        </div>

        {/* Right sidebar - fixed position */}
        {showPanel && selectedUser && (
          <div
            className="fixed right-0 top-14 bottom-0 z-50 bg-background border-l flex"
            style={{ width: panelWidth }}
          >
            {/* Resize handle */}
            <div
              className={cn(
                "w-1 cursor-col-resize hover:bg-primary/20 transition-colors flex-shrink-0",
                isResizing && "bg-primary/30"
              )}
              onMouseDown={handleResizeStart}
            />
            {/* Panel content */}
            <div className="flex-1 overflow-hidden">
              <UserDetailPanel
                user={selectedUser}
                onClose={handleClosePanel}
                onMakeAdmin={handleMakeAdmin}
                onRemoveAdmin={handleRemoveAdminFromPanel}
                onSetOverride={(uid, override) =>
                  handleSetOverride(uid, override)
                }
                onDeleteUser={handleDeleteUser}
                onImpersonate={handleImpersonate}
                onBulkRescan={handleBulkRescan}
                loading={
                  togglingAdmin === selectedUser.uid ||
                  settingOverride === selectedUser.uid
                }
                deletingUser={deletingUser === selectedUser.uid}
                impersonating={impersonatingUser === selectedUser.uid}
                bulkRescanning={bulkRescanning === selectedUser.uid}
              />
            </div>
          </div>
        )}

        {/* Prevent text selection while resizing */}
        {isResizing && (
          <div className="fixed inset-0 z-50 cursor-col-resize" />
        )}
      </div>
    </ProtectedRoute>
  );
}
