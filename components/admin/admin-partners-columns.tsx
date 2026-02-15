"use client";

import { ColumnDef } from "@tanstack/react-table";
import {
  Globe,
  Building2,
  Link2,
  Users,
  Check,
  X,
} from "lucide-react";
import { GlobalPartner, PromotionCandidate, UserPartner } from "@/types/partner";
import { formatIban } from "@/lib/import/deduplication";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Result of matching a candidate to existing global partners
 */
export interface CandidateMatch {
  globalPartner: GlobalPartner;
  matchType: "vatId" | "iban" | "name";
  confidence: number;
}

/**
 * Unified row type for the admin partners table
 * Must have `id` for TanStack Table compatibility
 */
export type AdminPartnerRow =
  | { id: string; type: "partner"; data: GlobalPartner }
  | { id: string; type: "candidate"; data: PromotionCandidate; match: CandidateMatch | null };

/**
 * Find potential matches between a user partner and existing global partners
 */
export function findCandidateMatches(
  userPartner: UserPartner,
  globalPartners: GlobalPartner[]
): CandidateMatch | null {
  // 1. VAT ID match (highest confidence)
  if (userPartner.vatId) {
    const normalizedVat = userPartner.vatId.replace(/\s/g, "").toUpperCase();
    const vatMatch = globalPartners.find(
      (gp) => gp.vatId?.replace(/\s/g, "").toUpperCase() === normalizedVat
    );
    if (vatMatch) {
      return { globalPartner: vatMatch, matchType: "vatId", confidence: 100 };
    }
  }

  // 2. IBAN match (very high confidence)
  if (userPartner.ibans.length > 0) {
    const normalizedIbans = userPartner.ibans.map((i) =>
      i.replace(/\s/g, "").toUpperCase()
    );
    for (const gp of globalPartners) {
      const gpNormalizedIbans = gp.ibans.map((i) =>
        i.replace(/\s/g, "").toUpperCase()
      );
      const hasMatch = normalizedIbans.some((iban) =>
        gpNormalizedIbans.includes(iban)
      );
      if (hasMatch) {
        return { globalPartner: gp, matchType: "iban", confidence: 95 };
      }
    }
  }

  // 3. Name match (fuzzy - lower confidence)
  const normalizedName = userPartner.name.toLowerCase().trim();
  const nameMatch = globalPartners.find((gp) => {
    const gpName = gp.name.toLowerCase().trim();
    if (gpName === normalizedName) return true;
    if (gp.aliases.some((a) => a.toLowerCase().trim() === normalizedName)) return true;
    if (userPartner.aliases.some((a) => a.toLowerCase().trim() === gpName)) return true;
    return false;
  });
  if (nameMatch) {
    return { globalPartner: nameMatch, matchType: "name", confidence: 80 };
  }

  return null;
}

function getConfidenceColor(confidence: number) {
  if (confidence >= 90)
    return "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300";
  if (confidence >= 70)
    return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-muted text-foreground";
}

function getMatchTypeLabel(matchType: CandidateMatch["matchType"]) {
  switch (matchType) {
    case "vatId": return "VAT ID";
    case "iban": return "IBAN";
    case "name": return "Name";
  }
}

interface ColumnOptions {
  onApprove?: (candidateId: string) => Promise<void>;
  onReject?: (candidateId: string) => Promise<void>;
}

export function getAdminPartnerColumns(
  options: ColumnOptions = {}
): ColumnDef<AdminPartnerRow>[] {
  const { onApprove, onReject } = options;

  return [
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => {
        const item = row.original;
        const isCandidate = item.type === "candidate";
        const name = isCandidate ? item.data.userPartner.name : item.data.name;
        const aliases = isCandidate ? item.data.userPartner.aliases : item.data.aliases;

        return (
          <div className="flex items-center gap-2">
            {isCandidate ? (
              <Building2 className="h-4 w-4 text-amber-500 flex-shrink-0" />
            ) : (
              <Globe className="h-4 w-4 text-blue-500 flex-shrink-0" />
            )}
            <div className="min-w-0">
              <div className="font-medium truncate">{name}</div>
              {aliases.length > 0 && (
                <div className="text-xs text-muted-foreground truncate">
                  aka: {aliases.slice(0, 2).join(", ")}
                  {aliases.length > 2 && ` +${aliases.length - 2}`}
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "vatId",
      header: "VAT ID",
      cell: ({ row }) => {
        const item = row.original;
        const vatId = item.type === "candidate"
          ? item.data.userPartner.vatId
          : item.data.vatId;
        return vatId || <span className="text-muted-foreground">-</span>;
      },
    },
    {
      id: "ibans",
      header: "IBANs",
      cell: ({ row }) => {
        const item = row.original;
        const ibans = item.type === "candidate"
          ? item.data.userPartner.ibans
          : item.data.ibans;

        if (ibans.length === 0) {
          return <span className="text-muted-foreground">-</span>;
        }
        return (
          <div className="text-sm">
            {formatIban(ibans[0])}
            {ibans.length > 1 && (
              <span className="text-muted-foreground ml-1">
                +{ibans.length - 1}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: "website",
      header: "Website",
      cell: ({ row }) => {
        const item = row.original;
        const website = item.type === "candidate"
          ? item.data.userPartner.website
          : item.data.website;

        if (!website) {
          return <span className="text-muted-foreground">-</span>;
        }

        if (item.type === "partner") {
          return (
            <a
              href={`https://${website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline text-sm"
              onClick={(e) => e.stopPropagation()}
            >
              {website}
            </a>
          );
        }
        return <span className="text-sm">{website}</span>;
      },
    },
    {
      id: "match",
      header: "Match",
      cell: ({ row }) => {
        const item = row.original;

        if (item.type === "partner") {
          return <span className="text-muted-foreground">-</span>;
        }

        const match = item.match;
        if (match) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5">
                  <Link2 className="h-3.5 w-3.5 text-blue-500" />
                  <span className="text-xs text-blue-600 dark:text-blue-400 truncate max-w-[100px]">
                    {match.globalPartner.name}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">{match.globalPartner.name}</p>
                <p className="text-xs text-muted-foreground">
                  Matched by {getMatchTypeLabel(match.matchType)} ({match.confidence}%)
                </p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return <span className="text-xs text-green-600 dark:text-green-400">New</span>;
      },
    },
    {
      id: "source",
      header: "Source",
      cell: ({ row }) => {
        const item = row.original;

        if (item.type === "candidate") {
          // For candidates, show confidence + user count + action buttons
          return (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge className={cn("text-xs", getConfidenceColor(item.data.confidence))}>
                  {item.data.confidence}%
                </Badge>
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {item.data.userCount}
                </span>
              </div>
              {(onApprove || onReject) && (
                <div className="flex items-center gap-1">
                  {onReject && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-100"
                      onClick={(e) => { e.stopPropagation(); onReject(item.data.id); }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  {onApprove && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-100"
                      onClick={(e) => { e.stopPropagation(); onApprove(item.data.id); }}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        }

        // For partners, show source badge
        return (
          <Badge variant="outline" className="text-xs">
            {item.data.source === "manual"
              ? "Manual"
              : item.data.source === "user_promoted"
              ? "User"
              : item.data.source === "preset"
              ? "Preset"
              : "Registry"}
          </Badge>
        );
      },
    },
  ];
}

// Default column sizes
export const DEFAULT_ADMIN_PARTNER_COLUMN_SIZES: Record<string, number> = {
  name: 200,
  vatId: 120,
  ibans: 180,
  website: 140,
  match: 120,
  source: 160,
};
