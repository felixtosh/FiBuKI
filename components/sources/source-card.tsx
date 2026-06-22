"use client";

import { useState } from "react";
import { TransactionSource } from "@/types/source";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Upload,
  ChevronRight,
  CreditCard,
  RefreshCw,
  Wallet,
  TrendingUp,
  Home,
  Shield,
  Landmark,
} from "lucide-react";
import { formatIban } from "@/lib/import/deduplication";
import { formatCurrency } from "@/lib/utils";
import { format } from "date-fns";

interface SourceCardProps {
  source: TransactionSource;
  onClick: () => void;
  onImportClick: () => void;
}

export function SourceCard({ source, onClick, onImportClick }: SourceCardProps) {
  // Capture "now" once per mount so checks derived from time remain pure.
  const [now] = useState(() => Date.now());

  // Check API connection status (TrueLayer or finAPI)
  const isApiConnected = source.type === "api" &&
    (source.apiConfig?.provider === "truelayer" ||
     source.apiConfig?.provider === "finapi");

  // Get expiry date and last sync from any provider (type-safe access to provider-specific fields)
  const apiConfig = source.apiConfig as Record<string, unknown> | undefined;
  const expiresAt = (() => {
    if (!apiConfig) return null;
    // finAPI/TrueLayer use expiresAt
    const expiry = apiConfig.expiresAt as { toDate?: () => Date } | string | undefined;
    if (typeof expiry === "object" && expiry?.toDate) return expiry.toDate();
    if (typeof expiry === "string") return new Date(expiry);
    return null;
  })();

  // Get last sync date
  const lastSyncAt = (() => {
    if (!apiConfig) return null;
    const syncAt = apiConfig.lastSyncAt as { toDate?: () => Date } | string | undefined;
    if (typeof syncAt === "object" && syncAt?.toDate) return syncAt.toDate();
    if (typeof syncAt === "string") return new Date(syncAt);
    return null;
  })();

  // Get institution logo for API sources
  const institutionLogo = apiConfig?.institutionLogo as string | undefined;

  // Check if re-auth is needed
  const needsReauth = isApiConnected && expiresAt
    ? expiresAt.getTime() < now
    : false;

  // Days until expiry
  const daysUntilExpiry = isApiConnected && expiresAt
    ? Math.max(0, Math.floor((expiresAt.getTime() - now) / (1000 * 60 * 60 * 24)))
    : null;

  // Only show badge for warnings or CSV - not for normal connected state
  const getStatusBadge = () => {
    if (source.type === "api") {
      if (needsReauth) {
        return <Badge variant="destructive" className="text-xs">Reconnect</Badge>;
      }
      if (isApiConnected && daysUntilExpiry !== null && daysUntilExpiry <= 7) {
        return <Badge variant="outline" className="text-xs border-yellow-500 text-yellow-600">Expires soon</Badge>;
      }
      // No badge for normal connected state
      return null;
    }
    // CSV import sources
    return <Badge variant="secondary" className="text-xs">CSV</Badge>;
  };

  // Broker name display for depot sources
  const BROKER_LABELS: Record<string, string> = {
    etoro: "eToro",
    bitpanda: "Bitpanda",
    trade_republic: "Trade Republic",
    flatex: "Flatex",
    interactive_brokers: "Interactive Brokers",
    other: "Broker",
  };

  // Get account type icon based on accountKind or finAPI accountType
  const getAccountTypeIcon = () => {
    if (source.accountKind === "credit_card") {
      return <CreditCard className="h-3 w-3" />;
    }
    if (source.accountKind === "depot") {
      return <TrendingUp className="h-3 w-3" />;
    }
    return <Building2 className="h-3 w-3" />;
  };

  // Render account icon - use bank logo with overlay for API sources, otherwise default icons
  const renderIcon = () => {
    if (isApiConnected && institutionLogo) {
      return (
        <div className="relative shrink-0">
          <img
            src={institutionLogo}
            alt=""
            className="h-10 w-10 rounded-lg object-contain border border-border"
          />
          {/* Account type overlay */}
          <div className="absolute -bottom-1 -right-1 p-1 rounded-full bg-background border border-border shadow-sm">
            {getAccountTypeIcon()}
          </div>
        </div>
      );
    }
    return (
      <div className="p-2 rounded-lg bg-primary/10 border border-border shrink-0">
        {source.accountKind === "credit_card" ? (
          <CreditCard className="h-5 w-5 text-primary" />
        ) : source.accountKind === "depot" ? (
          <TrendingUp className="h-5 w-5 text-primary" />
        ) : (
          <Building2 className="h-5 w-5 text-primary" />
        )}
      </div>
    );
  };

  const statusBadge = getStatusBadge();

  return (
    <Card
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onClick}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3 min-w-0">
            {renderIcon()}
            <div className="min-w-0">
              <h3 className="font-semibold truncate">{source.name}</h3>
            </div>
          </div>
          {statusBadge}
        </div>

        <p className="text-sm font-mono text-muted-foreground mb-1">
          {source.accountKind === "credit_card"
            ? `${source.cardBrand?.toUpperCase() || "Card"} ••••${source.cardLast4 || ""}`
            : source.accountKind === "depot"
              ? BROKER_LABELS[source.brokerName || "other"]
              : formatIban(source.iban)}
        </p>

        {source.latestBalance != null && (
          <p className={`text-lg font-semibold font-mono mb-3 ${source.latestBalance >= 0 ? "text-green-700" : "text-red-600"}`}>
            {formatCurrency(source.latestBalance, source.currency)}
            {source.latestBalanceDate && (
              <span className="text-xs font-normal text-muted-foreground ml-2">
                {format(source.latestBalanceDate.toDate(), "dd.MM.yyyy")}
              </span>
            )}
          </p>
        )}

        {source.latestBalance == null && <div className="mb-4" />}

        <div className="flex items-center justify-between">
          {!isApiConnected && (
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onImportClick();
              }}
              data-onboarding="import-transactions"
            >
              <Upload className="h-4 w-4 mr-2" />
              {source.accountKind === "depot" ? "Import Trades" : "Import"}
            </Button>
          )}
          {isApiConnected && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
              {lastSyncAt ? (
                <span>Last sync: {format(lastSyncAt, "MMM d, HH:mm")}</span>
              ) : (
                <span>Not synced yet</span>
              )}
            </div>
          )}

          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );
}
