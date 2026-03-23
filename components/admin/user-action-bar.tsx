"use client";

import { Loader2, Shield, ShieldOff, Gift, TestTube, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { UserRow } from "./user-columns";

interface UserActionBarProps {
  user: UserRow;
  onMakeAdmin: (uid: string) => Promise<void>;
  onRemoveAdmin: (uid: string) => Promise<void>;
  onSetOverride: (
    uid: string,
    override: "free_plan" | "plan_tester" | null
  ) => Promise<void>;
  loading: boolean;
}

export function UserActionBar({
  user,
  onMakeAdmin,
  onRemoveAdmin,
  onSetOverride,
  loading,
}: UserActionBarProps) {
  const showMakeAdmin = !user.isAdmin && !user.isSuperAdmin;
  const showRemoveAdmin = user.isAdmin && !user.isSuperAdmin;
  const showSetFree = !user.adminOverride;
  const showSetTester = !user.adminOverride;
  const showClearOverride = !!user.adminOverride;

  return (
    <div className="flex items-center justify-between border-t bg-muted/50 px-4 py-3 animate-in slide-in-from-bottom-2 duration-200">
      <div className="min-w-0">
        <p className="font-medium truncate text-sm">
          {user.displayName || user.email || user.uid}
        </p>
        {user.displayName && user.email && (
          <p className="text-xs text-muted-foreground truncate">
            {user.email}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {showMakeAdmin && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => onMakeAdmin(user.uid)}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Shield className="h-4 w-4 mr-1" />
                Make Admin
              </>
            )}
          </Button>
        )}

        {showRemoveAdmin && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={loading}
              >
                {loading ? (
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

        {showSetFree && (
          <Button
            variant="outline"
            size="sm"
            className="text-green-700 hover:text-green-800"
            disabled={loading}
            onClick={() => onSetOverride(user.uid, "free_plan")}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Gift className="h-4 w-4 mr-1" />
                Free Plan
              </>
            )}
          </Button>
        )}

        {showSetTester && (
          <Button
            variant="outline"
            size="sm"
            className="text-blue-700 hover:text-blue-800"
            disabled={loading}
            onClick={() => onSetOverride(user.uid, "plan_tester")}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <TestTube className="h-4 w-4 mr-1" />
                Tester
              </>
            )}
          </Button>
        )}

        {showClearOverride && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <X className="h-4 w-4 mr-1" />
                    Clear Override
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear Override?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will reset {user.email} to the Free plan with no special
                  override.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onSetOverride(user.uid, null)}
                >
                  Clear Override
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
