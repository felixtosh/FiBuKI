"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import type { PlanId } from "@/types/billing";

export interface UserRow {
  id: string; // mapped from uid for ResizableDataTable
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

export const PLAN_COLORS: Record<PlanId, string> = {
  free: "bg-stone-50 text-stone-900 border-stone-300",
  data: "bg-teal-50 text-teal-900 border-teal-300",
  smart: "bg-purple-50 text-purple-900 border-purple-300",
  pro: "bg-amber-50 text-amber-900 border-amber-300",
  // Legacy
  starter: "bg-blue-50 text-blue-900 border-blue-300",
  business: "bg-indigo-50 text-indigo-900 border-indigo-300",
};

export const DEFAULT_USER_COLUMN_SIZES: Record<string, number> = {
  user: 250,
  plan: 90,
  perks: 110,
  role: 100,
  transactions: 90,
  joined: 100,
};

export function getUserColumns(): ColumnDef<UserRow>[] {
  return [
    {
      id: "user",
      header: "User",
      cell: ({ row }) => {
        const { displayName, email, uid } = row.original;
        return (
          <div className="min-w-0">
            <div className="font-medium truncate">
              {displayName || email || uid}
            </div>
            {displayName && email && (
              <div className="text-xs text-muted-foreground truncate">
                {email}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "plan",
      header: "Plan",
      cell: ({ row }) => {
        const { plan } = row.original;
        return (
          <Badge variant="outline" className={PLAN_COLORS[plan]}>
            {plan}
          </Badge>
        );
      },
    },
    {
      id: "perks",
      header: "Perks",
      cell: ({ row }) => {
        const { adminOverride } = row.original;
        if (adminOverride === "free_plan") {
          return (
            <Badge
              variant="outline"
              className="bg-green-50 text-green-900 border-green-300"
            >
              Free Plan
            </Badge>
          );
        }
        if (adminOverride === "plan_tester") {
          return (
            <Badge
              variant="outline"
              className="bg-blue-50 text-blue-900 border-blue-300"
            >
              Tester
            </Badge>
          );
        }
        return <span className="text-muted-foreground">-</span>;
      },
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row }) => {
        const { isAdmin, isSuperAdmin } = row.original;
        if (isSuperAdmin) {
          return <Badge variant="secondary">Super Admin</Badge>;
        }
        if (isAdmin) {
          return <Badge variant="secondary">Admin</Badge>;
        }
        return <span className="text-muted-foreground">-</span>;
      },
    },
    {
      id: "transactions",
      header: () => <div className="text-right">Transactions</div>,
      cell: ({ row }) => (
        <div className="text-right tabular-nums">
          {row.original.transactionCount.toLocaleString()}
        </div>
      ),
    },
    {
      id: "joined",
      header: "Joined",
      cell: ({ row }) => {
        const { createdAt } = row.original;
        if (!createdAt) {
          return <span className="text-muted-foreground">-</span>;
        }
        return (
          <span className="text-sm text-muted-foreground">
            {formatDistanceToNow(new Date(createdAt), { addSuffix: true })}
          </span>
        );
      },
    },
  ];
}
