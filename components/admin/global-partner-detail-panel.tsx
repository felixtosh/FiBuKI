"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  X,
  Globe,
  CreditCard,
  FileText,
  Pencil,
  Trash2,
  ExternalLink,
  Users,
  Sparkles,
  Database,
  CheckCircle,
  Clock,
} from "lucide-react";
import { GlobalPartner, GlobalPartnerFormData } from "@/types/partner";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { formatIban } from "@/lib/import/deduplication";
import { useState } from "react";
import { AddGlobalPartnerDialog } from "./add-global-partner-dialog";
import { format } from "date-fns";

interface GlobalPartnerDetailPanelProps {
  partner: GlobalPartner;
  onClose: () => void;
}

export function GlobalPartnerDetailPanel({
  partner,
  onClose,
}: GlobalPartnerDetailPanelProps) {
  const { updatePartner, deletePartner } = useGlobalPartners();
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const handleEdit = async (data: GlobalPartnerFormData) => {
    await updatePartner(partner.id, data);
  };

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this global partner?")) {
      await deletePartner(partner.id);
      onClose();
    }
  };

  const getSourceLabel = (source: GlobalPartner["source"]) => {
    switch (source) {
      case "manual":
        return "Manual";
      case "user_promoted":
        return "User Promoted";
      case "external_registry":
        return "External Registry";
      case "preset":
        return "Preset";
      default:
        return source;
    }
  };

  const getSourceColor = (source: GlobalPartner["source"]) => {
    switch (source) {
      case "manual":
        return "bg-blue-50 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300";
      case "user_promoted":
        return "bg-purple-50 text-purple-900 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300";
      case "external_registry":
        return "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300";
      case "preset":
        return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
      default:
        return "";
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Globe className="h-5 w-5 text-blue-500 flex-shrink-0" />
          <h2 className="font-semibold truncate">{partner.name}</h2>
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
        {/* Source Badge */}
        <div className="flex items-center gap-2">
          <Badge className={getSourceColor(partner.source)}>
            {partner.source === "preset" && (
              <Database className="h-3 w-3 mr-1" />
            )}
            {getSourceLabel(partner.source)}
          </Badge>
          {!partner.isActive && (
            <Badge variant="destructive">Inactive</Badge>
          )}
        </div>

        {/* Aliases */}
        {partner.aliases.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Also known as
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {partner.aliases.map((alias, idx) => (
                <Badge key={idx} variant="secondary" className="text-xs">
                  {alias}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* VAT ID */}
        {partner.vatId && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              <FileText className="h-3 w-3 inline mr-1" />
              VAT ID
            </h3>
            <p className="text-sm font-mono">{partner.vatId}</p>
          </div>
        )}

        {/* IBANs */}
        {partner.ibans.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              <CreditCard className="h-3 w-3 inline mr-1" />
              Bank Accounts
            </h3>
            <div className="space-y-1">
              {partner.ibans.map((iban, idx) => (
                <p key={idx} className="text-sm font-mono">
                  {formatIban(iban)}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Website */}
        {partner.website && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              <Globe className="h-3 w-3 inline mr-1" />
              Website
            </h3>
            <a
              href={`https://${partner.website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              {partner.website}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}

        {/* Address */}
        {partner.address && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Address
            </h3>
            <div className="text-sm space-y-0.5">
              {partner.address.street && (
                <p className="whitespace-pre-line">{partner.address.street}</p>
              )}
              {(partner.address.postalCode || partner.address.city) && (
                <p>
                  {[partner.address.postalCode, partner.address.city]
                    .filter(Boolean)
                    .join(" ")}
                </p>
              )}
              {partner.address.country && <p>{partner.address.country}</p>}
            </div>
          </div>
        )}

        {/* Country */}
        {partner.country && !partner.address?.country && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Country
            </h3>
            <p className="text-sm">{partner.country}</p>
          </div>
        )}

        {/* External IDs */}
        {partner.externalIds &&
          Object.keys(partner.externalIds).length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                External IDs
              </h3>
              <div className="space-y-1">
                {partner.externalIds.justizOnline && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">Justiz Online:</span>{" "}
                    <span className="font-mono">
                      {partner.externalIds.justizOnline}
                    </span>
                  </p>
                )}
                {partner.externalIds.euCompany && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">EU Company:</span>{" "}
                    <span className="font-mono">
                      {partner.externalIds.euCompany}
                    </span>
                  </p>
                )}
                {partner.externalIds.lei && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">LEI:</span>{" "}
                    <span className="font-mono">{partner.externalIds.lei}</span>
                  </p>
                )}
              </div>
            </div>
          )}

        {/* Static Patterns */}
        {partner.patterns && partner.patterns.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              <Sparkles className="h-3 w-3 inline mr-1" />
              Matching Patterns
            </h3>
            <div className="space-y-1.5">
              {partner.patterns.map((pattern, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <code className="text-xs bg-muted px-2 py-1 rounded font-mono flex-1 truncate">
                    {pattern.pattern}
                  </code>
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {pattern.confidence}%
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Source Details */}
        {partner.sourceDetails && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              <Users className="h-3 w-3 inline mr-1" />
              Source Details
            </h3>
            <div className="space-y-2 text-sm">
              {partner.sourceDetails.contributingUserIds.length > 0 && (
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {partner.sourceDetails.contributingUserIds.length} contributing
                    user{partner.sourceDetails.contributingUserIds.length !== 1 ? "s" : ""}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Confidence:</span>
                <Badge
                  variant="outline"
                  className={
                    partner.sourceDetails.confidence >= 90
                      ? "bg-green-50 text-green-900 border-green-300"
                      : partner.sourceDetails.confidence >= 70
                      ? "bg-amber-50 text-amber-900 border-amber-300"
                      : ""
                  }
                >
                  {partner.sourceDetails.confidence}%
                </Badge>
              </div>
              {partner.sourceDetails.verifiedAt && (
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span>
                    Verified{" "}
                    {format(
                      partner.sourceDetails.verifiedAt.toDate(),
                      "MMM d, yyyy"
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div className="pt-4 border-t">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>
              Created {format(partner.createdAt.toDate(), "MMM d, yyyy")}
            </span>
          </div>
          {partner.updatedAt && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
              <Clock className="h-3 w-3" />
              <span>
                Updated {format(partner.updatedAt.toDate(), "MMM d, yyyy")}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-4 border-t flex gap-2">
        <Button
          variant="outline"
          className="flex-1 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={handleDelete}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => setIsEditDialogOpen(true)}
        >
          <Pencil className="h-4 w-4 mr-2" />
          Edit
        </Button>
      </div>

      {/* Edit Dialog */}
      <AddGlobalPartnerDialog
        open={isEditDialogOpen}
        onClose={() => setIsEditDialogOpen(false)}
        onSave={handleEdit}
        editingPartner={partner}
      />
    </div>
  );
}
