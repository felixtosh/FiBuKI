"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SourceFormData, TransactionSource, AccountKind, CardBrand, BrokerName } from "@/types/source";
import { isValidIban, normalizeIban, formatIban } from "@/lib/import/deduplication";
import { Building2, CreditCard, TrendingUp } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import { cn } from "@/lib/utils";

interface AddSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (data: SourceFormData) => Promise<string>;
  sources?: TransactionSource[];
}

const CARD_BRANDS: { value: CardBrand; label: string }[] = [
  { value: "visa", label: "Visa" },
  { value: "mastercard", label: "Mastercard" },
  { value: "amex", label: "American Express" },
  { value: "discover", label: "Discover" },
  { value: "other", label: "Other" },
];

const BROKERS: { value: BrokerName; label: string }[] = [
  { value: "trade_republic", label: "Trade Republic" },
  { value: "flatex", label: "Flatex" },
  { value: "interactive_brokers", label: "Interactive Brokers" },
  { value: "etoro", label: "eToro" },
  { value: "bitpanda", label: "Bitpanda" },
  { value: "other", label: "Other" },
];

export function AddSourceDialog({ open, onClose, onAdd, sources = [] }: AddSourceDialogProps) {
  const { subscription } = useSubscription();
  const hasInvestmentsAddon = subscription?.addons?.investments?.active ?? false;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ibanError, setIbanError] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    name: string;
    accountKind: AccountKind;
    iban: string;
    cardBrand: CardBrand;
    cardLast4: string;
    linkedSourceId: string;
    brokerName: BrokerName;
    currency: string;
    type: "csv" | "api";
  }>({
    name: "",
    accountKind: "bank_account",
    iban: "",
    cardBrand: "visa",
    cardLast4: "",
    linkedSourceId: "",
    brokerName: "other",
    currency: "EUR",
    type: "csv",
  });

  // Filter to only show bank accounts as linkable sources
  const linkableSources = sources.filter(s => s.accountKind === "bank_account");

  const handleIbanChange = (value: string) => {
    setFormData((f) => ({ ...f, iban: value }));
    setIbanError(null);
  };

  const handleIbanBlur = () => {
    if (formData.iban) {
      const normalized = normalizeIban(formData.iban);
      if (!isValidIban(normalized)) {
        setIbanError("Invalid IBAN format");
      } else {
        setFormData((f) => ({ ...f, iban: formatIban(normalized) }));
      }
    }
  };

  const handleAccountKindChange = (kind: AccountKind) => {
    setFormData((f) => ({
      ...f,
      accountKind: kind,
    }));
    if (kind === "credit_card") {
      setIbanError(null);
    }
  };

  const handleLast4Change = (value: string) => {
    // Only allow digits and max 4 characters
    const digits = value.replace(/\D/g, "").slice(0, 4);
    setFormData((f) => ({ ...f, cardLast4: digits }));
  };

  const canSubmit = () => {
    if (!formData.name) return false;

    if (formData.accountKind === "bank_account") {
      // For bank accounts, IBAN is optional but must be valid if provided
      if (ibanError) return false;
    } else if (formData.accountKind === "credit_card") {
      // For credit cards, card info is required
      if (!formData.cardBrand) return false;
      if (!formData.cardLast4 || formData.cardLast4.length !== 4) return false;
    }
    // Depot: only name is required (broker is optional)

    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit()) return;

    // Validate IBAN if provided (bank account)
    if (formData.accountKind === "bank_account" && formData.iban && !isValidIban(formData.iban)) {
      setIbanError("Invalid IBAN format");
      return;
    }

    setIsSubmitting(true);
    try {
      await onAdd({
        name: formData.name,
        accountKind: formData.accountKind,
        iban: formData.accountKind === "bank_account" ? formData.iban : undefined,
        cardBrand: formData.accountKind === "credit_card" ? formData.cardBrand : undefined,
        cardLast4: formData.accountKind === "credit_card" ? formData.cardLast4 : undefined,
        brokerName: formData.accountKind === "depot" ? formData.brokerName : undefined,
        linkedSourceId: formData.linkedSourceId || undefined,
        currency: formData.currency,
        type: formData.type,
      });

      // Reset form
      setFormData({
        name: "",
        accountKind: "bank_account",
        iban: "",
        cardBrand: "visa",
        cardLast4: "",
        linkedSourceId: "",
        brokerName: "other",
        currency: "EUR",
        type: "csv" as const,
      });
      setIbanError(null);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className="w-[450px] sm:w-[500px]">
        <SheetHeader>
          <SheetTitle>Add Account</SheetTitle>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {/* Account Type Selector */}
          <div>
            <label className="text-sm font-medium mb-2 block">
              Account Type *
            </label>
            <div className={cn("grid gap-2", hasInvestmentsAddon ? "grid-cols-3" : "grid-cols-2")}>
              <button
                type="button"
                onClick={() => handleAccountKindChange("bank_account")}
                className={cn(
                  "flex items-center gap-2 p-3 rounded-lg border-2 transition-colors",
                  formData.accountKind === "bank_account"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <Building2 className="h-5 w-5" />
                <span className="font-medium">Bank Account</span>
              </button>
              <button
                type="button"
                onClick={() => handleAccountKindChange("credit_card")}
                className={cn(
                  "flex items-center gap-2 p-3 rounded-lg border-2 transition-colors",
                  formData.accountKind === "credit_card"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <CreditCard className="h-5 w-5" />
                <span className="font-medium">Credit Card</span>
              </button>
              {hasInvestmentsAddon && (
                <button
                  type="button"
                  onClick={() => handleAccountKindChange("depot")}
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-lg border-2 transition-colors",
                    formData.accountKind === "depot"
                      ? "border-primary bg-primary/5"
                      : "border-muted hover:border-muted-foreground/50"
                  )}
                >
                  <TrendingUp className="h-5 w-5" />
                  <span className="font-medium">Depot</span>
                </button>
              )}
            </div>
          </div>

          {/* Account Name */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Account Name *
            </label>
            <Input
              placeholder={
                formData.accountKind === "credit_card"
                  ? "e.g., Amex Business Card"
                  : formData.accountKind === "depot"
                    ? "e.g., Trade Republic Depot"
                    : "e.g., Business Account"
              }
              value={formData.name}
              onChange={(e) =>
                setFormData((f) => ({ ...f, name: e.target.value }))
              }
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              A friendly name to identify this account
            </p>
          </div>

          {/* Broker - Only for depot sources */}
          {formData.accountKind === "depot" && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Broker
              </label>
              <Select
                value={formData.brokerName}
                onValueChange={(value) =>
                  setFormData((f) => ({ ...f, brokerName: value as BrokerName }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BROKERS.map((broker) => (
                    <SelectItem key={broker.value} value={broker.value}>
                      {broker.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Helps with automatic column matching during CSV import
              </p>
            </div>
          )}

          {/* IBAN - Only for bank accounts */}
          {formData.accountKind === "bank_account" && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                IBAN
              </label>
              <Input
                placeholder="AT12 3456 7890 1234 5678"
                value={formData.iban}
                onChange={(e) => handleIbanChange(e.target.value)}
                onBlur={handleIbanBlur}
                className={ibanError ? "border-destructive" : ""}
              />
              {ibanError && (
                <p className="text-xs text-destructive mt-1">{ibanError}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Used for deduplication when importing transactions
              </p>
            </div>
          )}

          {/* Card Type and Last 4 - Only for credit cards */}
          {formData.accountKind === "credit_card" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Card Type *
                </label>
                <Select
                  value={formData.cardBrand}
                  onValueChange={(value) =>
                    setFormData((f) => ({ ...f, cardBrand: value as CardBrand }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CARD_BRANDS.map((brand) => (
                      <SelectItem key={brand.value} value={brand.value}>
                        {brand.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Last 4 Digits *
                </label>
                <Input
                  placeholder="1234"
                  value={formData.cardLast4}
                  onChange={(e) => handleLast4Change(e.target.value)}
                  maxLength={4}
                  className="font-mono"
                />
              </div>
            </div>
          )}

          {/* Primary Currency */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Primary Currency
            </label>
            <Select
              value={formData.currency}
              onValueChange={(value) =>
                setFormData((f) => ({ ...f, currency: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EUR">EUR - Euro</SelectItem>
                <SelectItem value="USD">USD - US Dollar</SelectItem>
                <SelectItem value="GBP">GBP - British Pound</SelectItem>
                <SelectItem value="CHF">CHF - Swiss Franc</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Linked Bank Account - Only for credit cards */}
          {formData.accountKind === "credit_card" && linkableSources.length > 0 && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Linked Bank Account
              </label>
              <Select
                value={formData.linkedSourceId || "none"}
                onValueChange={(value) =>
                  setFormData((f) => ({ ...f, linkedSourceId: value === "none" ? "" : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a bank account..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {linkableSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                The bank account this card bills to
              </p>
            </div>
          )}

          <div className="flex gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !canSubmit()}
              className="flex-1"
            >
              {isSubmitting ? "Adding..." : "Add Account"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
