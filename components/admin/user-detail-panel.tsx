"use client";

import {
  X,
  User,
  Shield,
  ShieldOff,
  Gift,
  TestTube,
  Clock,
  Receipt,
  Loader2,
  CreditCard,
  Trash2,
  UserCog,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { formatDistanceToNow } from "date-fns";
import { PLAN_COLORS, type UserRow } from "./user-columns";

interface UserDetailPanelProps {
  user: UserRow;
  onClose: () => void;
  onMakeAdmin: (uid: string) => Promise<void>;
  onRemoveAdmin: (uid: string) => Promise<void>;
  onSetOverride: (
    uid: string,
    override: "free_plan" | "plan_tester" | null
  ) => Promise<void>;
  onDeleteUser: (uid: string) => Promise<void>;
  onImpersonate: (uid: string) => Promise<void>;
  onBulkRescan: (uid: string) => Promise<void>;
  loading: boolean;
  deletingUser: boolean;
  impersonating: boolean;
  bulkRescanning: boolean;
}

export function UserDetailPanel({
  user,
  onClose,
  onMakeAdmin,
  onRemoveAdmin,
  onSetOverride,
  onDeleteUser,
  onImpersonate,
  onBulkRescan,
  loading,
  deletingUser,
  impersonating,
  bulkRescanning,
}: UserDetailPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <User className="h-5 w-5 text-primary flex-shrink-0" />
          <h2 className="font-semibold truncate">
            {user.displayName || user.email || user.uid}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="flex-shrink-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Email */}
        {user.email && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              Email
            </h3>
            <p className="text-sm">{user.email}</p>
          </div>
        )}

        {/* UID */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            User ID
          </h3>
          <p className="text-sm font-mono text-muted-foreground">{user.uid}</p>
        </div>

        {/* Plan */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            <CreditCard className="h-3 w-3 inline mr-1" />
            Plan
          </h3>
          <Badge variant="outline" className={PLAN_COLORS[user.plan]}>
            {user.plan}
          </Badge>
          {user.stripeSubscriptionStatus &&
            user.stripeSubscriptionStatus !== "none" && (
              <span className="text-xs text-muted-foreground ml-2">
                ({user.stripeSubscriptionStatus})
              </span>
            )}
        </div>

        {/* Perks */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Perks
          </h3>
          {user.adminOverride === "free_plan" ? (
            <Badge
              variant="outline"
              className="bg-green-50 text-green-900 border-green-300"
            >
              <Gift className="h-3 w-3 mr-1" />
              Free Plan
            </Badge>
          ) : user.adminOverride === "plan_tester" ? (
            <Badge
              variant="outline"
              className="bg-blue-50 text-blue-900 border-blue-300"
            >
              <TestTube className="h-3 w-3 mr-1" />
              Tester
            </Badge>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </div>

        {/* Role */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            <Shield className="h-3 w-3 inline mr-1" />
            Role
          </h3>
          {user.isSuperAdmin ? (
            <Badge variant="secondary">Super Admin</Badge>
          ) : user.isAdmin ? (
            <Badge variant="secondary">Admin</Badge>
          ) : (
            <span className="text-sm text-muted-foreground">User</span>
          )}
        </div>

        {/* Transactions */}
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            <Receipt className="h-3 w-3 inline mr-1" />
            Transactions
          </h3>
          <p className="text-sm tabular-nums">
            {user.transactionCount.toLocaleString()}
          </p>
        </div>

        {/* Joined */}
        {user.createdAt && (
          <div className="pt-4 border-t">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>
                Joined{" "}
                {formatDistanceToNow(new Date(user.createdAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="p-4 border-t space-y-2">
        {/* Admin actions */}
        {!user.isAdmin && !user.isSuperAdmin && (
          <Button
            variant="outline"
            className="w-full"
            disabled={loading}
            onClick={() => onMakeAdmin(user.uid)}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Shield className="h-4 w-4 mr-2" />
            )}
            Make Admin
          </Button>
        )}

        {user.isAdmin && !user.isSuperAdmin && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ShieldOff className="h-4 w-4 mr-2" />
                )}
                Remove Admin
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove Admin?</AlertDialogTitle>
                <AlertDialogDescription>
                  {user.email} will no longer be able to manage users or access
                  admin settings.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onRemoveAdmin(user.uid)}
                  className="bg-destructive text-destructive-foreground"
                >
                  Remove Admin
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* Perk actions */}
        {!user.adminOverride && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 text-green-700 hover:text-green-800"
              disabled={loading}
              onClick={() => onSetOverride(user.uid, "free_plan")}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Gift className="h-4 w-4 mr-2" />
              )}
              Free Plan
            </Button>
            <Button
              variant="outline"
              className="flex-1 text-blue-700 hover:text-blue-800"
              disabled={loading}
              onClick={() => onSetOverride(user.uid, "plan_tester")}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <TestTube className="h-4 w-4 mr-2" />
              )}
              Tester
            </Button>
          </div>
        )}

        {user.adminOverride && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <X className="h-4 w-4 mr-2" />
                )}
                Clear Perk
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear Perk?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will reset {user.email} to the Free plan with no special
                  perk.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onSetOverride(user.uid, null)}
                >
                  Clear Perk
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* Impersonate — hidden for super admins and other admins (not allowed by backend) */}
        {!user.isSuperAdmin && !user.isAdmin && (
          <Button
            variant="outline"
            className="w-full"
            disabled={loading || impersonating}
            onClick={() => onImpersonate(user.uid)}
          >
            {impersonating ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <UserCog className="h-4 w-4 mr-2" />
            )}
            Impersonate (opens new tab)
          </Button>
        )}

        {/* Bulk rescan errored extractions */}
        <Button
          variant="outline"
          className="w-full"
          disabled={loading || bulkRescanning}
          onClick={() => onBulkRescan(user.uid)}
        >
          {bulkRescanning ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Rescan all errored files
        </Button>

        {/* Delete user — hidden for super admins */}
        {!user.isSuperAdmin && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="w-full"
                disabled={loading || deletingUser}
              >
                {deletingUser ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete User
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete User Account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all data for{" "}
                  <span className="font-medium text-foreground">
                    {user.email || user.uid}
                  </span>
                  , including transactions, files, partners, and storage. This
                  action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDeleteUser(user.uid)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete User
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
