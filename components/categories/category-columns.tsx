"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Tag, Building2, Receipt } from "lucide-react";
import { UserNoReceiptCategory } from "@/types/no-receipt-category";

export function getCategoryColumns(): ColumnDef<UserNoReceiptCategory>[] {
  return [
    {
      accessorKey: "name",
      header: "Category",
      cell: ({ row }) => {
        const category = row.original;
        return (
          <div className="flex items-start gap-3">
            <Tag className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{category.name}</p>
              <p className="text-xs text-muted-foreground line-clamp-1">
                {category.helperText}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      id: "partners",
      header: "Partners",
      cell: ({ row }) => {
        const category = row.original;
        return (
          <div className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm">{category.matchedPartnerIds.length}</span>
          </div>
        );
      },
    },
    {
      id: "transactions",
      header: "Transactions",
      cell: ({ row }) => {
        const category = row.original;
        return (
          <div className="flex items-center gap-1.5">
            <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm">{category.transactionCount}</span>
          </div>
        );
      },
    },
  ];
}
