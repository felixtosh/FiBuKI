"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  X,
  Building2,
  Globe,
  CreditCard,
  FileText,
  ExternalLink,
  Users,
  Check,
  ArrowRight,
  Plus,
  RefreshCw,
  Link2,
} from "lucide-react";
import { PromotionCandidate, GlobalPartner, UserPartner } from "@/types/partner";
import { CandidateMatch } from "./admin-partners-table";
import { formatIban } from "@/lib/import/deduplication";
import { format } from "date-fns";

interface CandidateDetailPanelProps {
  candidate: PromotionCandidate;
  match: CandidateMatch | null;
  onClose: () => void;
  onApprove: (candidateId: string) => Promise<void>;
  onReject: (candidateId: string) => Promise<void>;
  onMerge?: (candidateId: string, globalPartnerId: string) => Promise<void>;
}

interface FieldDelta {
  field: string;
  label: string;
  candidateValue: string | string[] | null;
  existingValue: string | string[] | null;
  isNew: boolean;
  isDifferent: boolean;
}

/**
 * Compare a candidate's user partner with a matched global partner
 * to find delta fields (new or different values)
 */
function computeDeltas(
  userPartner: UserPartner,
  globalPartner: GlobalPartner
): FieldDelta[] {
  const deltas: FieldDelta[] = [];

  // Name comparison
  if (userPartner.name !== globalPartner.name) {
    deltas.push({
      field: "name",
      label: "Name",
      candidateValue: userPartner.name,
      existingValue: globalPartner.name,
      isNew: false,
      isDifferent: true,
    });
  }

  // VAT ID comparison
  const normalizeVat = (v?: string) => v?.replace(/\s/g, "").toUpperCase() || null;
  const candidateVat = normalizeVat(userPartner.vatId);
  const existingVat = normalizeVat(globalPartner.vatId);
  if (candidateVat && candidateVat !== existingVat) {
    deltas.push({
      field: "vatId",
      label: "VAT ID",
      candidateValue: userPartner.vatId || null,
      existingValue: globalPartner.vatId || null,
      isNew: !existingVat,
      isDifferent: !!existingVat,
    });
  }

  // Website comparison
  const normalizeWebsite = (w?: string) => w?.toLowerCase().replace(/^www\./, "") || null;
  const candidateWebsite = normalizeWebsite(userPartner.website);
  const existingWebsite = normalizeWebsite(globalPartner.website);
  if (candidateWebsite && candidateWebsite !== existingWebsite) {
    deltas.push({
      field: "website",
      label: "Website",
      candidateValue: userPartner.website || null,
      existingValue: globalPartner.website || null,
      isNew: !existingWebsite,
      isDifferent: !!existingWebsite,
    });
  }

  // IBANs - find new ones
  const normalizeIban = (i: string) => i.replace(/\s/g, "").toUpperCase();
  const existingIbans = new Set(globalPartner.ibans.map(normalizeIban));
  const newIbans = userPartner.ibans.filter(
    (iban) => !existingIbans.has(normalizeIban(iban))
  );
  if (newIbans.length > 0) {
    deltas.push({
      field: "ibans",
      label: "Bank Accounts",
      candidateValue: newIbans,
      existingValue: globalPartner.ibans.length > 0 ? globalPartner.ibans : null,
      isNew: globalPartner.ibans.length === 0,
      isDifferent: false,
    });
  }

  // Aliases - find new ones
  const normalizeAlias = (a: string) => a.toLowerCase().trim();
  const existingAliases = new Set(globalPartner.aliases.map(normalizeAlias));
  existingAliases.add(globalPartner.name.toLowerCase().trim());
  const newAliases = userPartner.aliases.filter(
    (alias) => !existingAliases.has(normalizeAlias(alias))
  );
  if (newAliases.length > 0) {
    deltas.push({
      field: "aliases",
      label: "Also Known As",
      candidateValue: newAliases,
      existingValue: globalPartner.aliases.length > 0 ? globalPartner.aliases : null,
      isNew: globalPartner.aliases.length === 0,
      isDifferent: false,
    });
  }

  return deltas;
}

export function CandidateDetailPanel({
  candidate,
  match,
  onClose,
  onApprove,
  onReject,
  onMerge,
}: CandidateDetailPanelProps) {
  const userPartner = candidate.userPartner;
  const deltas = match ? computeDeltas(userPartner, match.globalPartner) : [];
  const hasNewData = deltas.some((d) => d.isNew || (Array.isArray(d.candidateValue) && d.candidateValue.length > 0));

  const getMatchTypeLabel = (matchType: CandidateMatch["matchType"]) => {
    switch (matchType) {
      case "vatId": return "VAT ID";
      case "iban": return "IBAN";
      case "name": return "Name";
    }
  };

  const handleApprove = async () => {
    await onApprove(candidate.id);
    onClose();
  };

  const handleReject = async () => {
    await onReject(candidate.id);
    onClose();
  };

  const handleMerge = async () => {
    if (match && onMerge) {
      await onMerge(candidate.id, match.globalPartner.id);
      onClose();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-amber-50/50 dark:bg-amber-950/20">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="h-5 w-5 text-amber-500 flex-shrink-0" />
          <h2 className="font-semibold truncate">{userPartner.name}</h2>
          <Badge variant="secondary" className="text-xs bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/50 dark:text-amber-300">
            Suggestion
          </Badge>
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
        {/* Confidence & User Count */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Confidence:</span>
            <Badge
              className={
                candidate.confidence >= 90
                  ? "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300"
                  : candidate.confidence >= 70
                  ? "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300"
                  : "bg-muted text-foreground"
              }
            >
              {candidate.confidence}%
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">
              {candidate.userCount} user{candidate.userCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* Match Status */}
        {match ? (
          <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Link2 className="h-4 w-4 text-blue-500" />
              <span className="font-medium text-blue-700 dark:text-blue-400">
                Matches Existing Partner
              </span>
              <Badge variant="outline" className="text-xs">
                {getMatchTypeLabel(match.matchType)} ({match.confidence}%)
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-500" />
              <span className="font-medium">{match.globalPartner.name}</span>
            </div>
            {match.globalPartner.vatId && (
              <p className="text-sm text-muted-foreground mt-1 ml-6">
                VAT: {match.globalPartner.vatId}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 p-4">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-green-500" />
              <span className="font-medium text-green-700 dark:text-green-400">
                New Partner
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1 ml-6">
              No existing global partner found. Will be created as new.
            </p>
          </div>
        )}

        {/* Delta Fields (if there's a match) */}
        {match && deltas.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              New Data to Add
            </h3>
            <div className="space-y-3">
              {deltas.map((delta) => (
                <div
                  key={delta.field}
                  className="rounded-lg border p-3 bg-muted/20"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium">{delta.label}</span>
                    {delta.isNew && (
                      <Badge variant="secondary" className="text-xs bg-green-50 text-green-900 border-green-300 dark:bg-green-900/50 dark:text-green-300">
                        New
                      </Badge>
                    )}
                    {delta.isDifferent && (
                      <Badge variant="secondary" className="text-xs bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/50 dark:text-amber-300">
                        Different
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-start gap-2">
                    {delta.existingValue && (
                      <>
                        <div className="text-sm text-muted-foreground">
                          {Array.isArray(delta.existingValue)
                            ? delta.existingValue.join(", ")
                            : delta.existingValue}
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                      </>
                    )}
                    <div className="text-sm font-medium text-green-700 dark:text-green-400">
                      {Array.isArray(delta.candidateValue)
                        ? delta.candidateValue.join(", ")
                        : delta.candidateValue}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {match && deltas.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No new data to add. The candidate has the same information as the existing partner.
          </div>
        )}

        {/* Candidate Details */}
        <div className="pt-4 border-t">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Candidate Details
          </h3>

          {/* Aliases */}
          {userPartner.aliases.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs text-muted-foreground mb-1">Also known as</h4>
              <div className="flex flex-wrap gap-1.5">
                {userPartner.aliases.map((alias, idx) => (
                  <Badge key={idx} variant="secondary" className="text-xs">
                    {alias}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* VAT ID */}
          {userPartner.vatId && (
            <div className="mb-4">
              <h4 className="text-xs text-muted-foreground mb-1">
                <FileText className="h-3 w-3 inline mr-1" />
                VAT ID
              </h4>
              <p className="text-sm font-mono">{userPartner.vatId}</p>
            </div>
          )}

          {/* IBANs */}
          {userPartner.ibans.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs text-muted-foreground mb-1">
                <CreditCard className="h-3 w-3 inline mr-1" />
                Bank Accounts
              </h4>
              <div className="space-y-1">
                {userPartner.ibans.map((iban, idx) => (
                  <p key={idx} className="text-sm font-mono">
                    {formatIban(iban)}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Website */}
          {userPartner.website && (
            <div className="mb-4">
              <h4 className="text-xs text-muted-foreground mb-1">
                <Globe className="h-3 w-3 inline mr-1" />
                Website
              </h4>
              <a
                href={`https://${userPartner.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                {userPartner.website}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>

        {/* Created timestamp */}
        <div className="text-xs text-muted-foreground">
          Suggested {format(candidate.createdAt.toDate(), "MMM d, yyyy")}
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-4 border-t space-y-2">
        {match ? (
          <>
            {hasNewData && onMerge && (
              <Button className="w-full" onClick={handleMerge}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Merge with {match.globalPartner.name}
              </Button>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={handleReject}
              >
                <X className="h-4 w-4 mr-2" />
                Reject
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleApprove}
              >
                <Plus className="h-4 w-4 mr-2" />
                Create New Anyway
              </Button>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={handleReject}
            >
              <X className="h-4 w-4 mr-2" />
              Reject
            </Button>
            <Button className="flex-1" onClick={handleApprove}>
              <Check className="h-4 w-4 mr-2" />
              Approve
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
