"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
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
import { TransactionSource, AccountKind, CardBrand } from "@/types/source";
import { isValidIban, normalizeIban, formatIban } from "@/lib/import/deduplication";
import { Banknote, Building2, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

interface EditSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<TransactionSource>) => Promise<void>;
  source: TransactionSource;
  sources?: TransactionSource[];
}

const CARD_BRANDS: { value: CardBrand; label: string }[] = [
  { value: "visa", label: "Visa" },
  { value: "mastercard", label: "Mastercard" },
  { value: "amex", label: "American Express" },
  { value: "discover", label: "Discover" },
  { value: "other", label: "Other" },
];

export function EditSourceDialog({ open, onClose, onSave, source, sources = [] }: EditSourceDialogProps) {
  const t = useTranslations("sources");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ibanError, setIbanError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    accountKind: "bank_account" as AccountKind,
    iban: "",
    cardBrand: "visa" as CardBrand,
    cardLast4: "",
    linkedSourceId: "",
    currency: "EUR",
  });

  // Initialize form when source changes
  useEffect(() => {
    if (source) {
      setFormData({
        name: source.name,
        accountKind: source.accountKind || "bank_account",
        iban: source.iban ? formatIban(source.iban) : "",
        cardBrand: source.cardBrand || "visa",
        cardLast4: source.cardLast4 || "",
        linkedSourceId: source.linkedSourceId || "",
        currency: source.currency || "EUR",
      });
      setIbanError(null);
    }
  }, [source]);

  // Filter to only show bank accounts as linkable sources (exclude current source)
  const linkableSources = sources.filter(
    s => s.accountKind === "bank_account" && s.id !== source.id
  );

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
      // For bank accounts, IBAN is required
      if (!formData.iban) return false;
      if (ibanError) return false;
    } else if (formData.accountKind === "credit_card") {
      // For credit cards, card info is required
      if (!formData.cardBrand) return false;
      if (!formData.cardLast4 || formData.cardLast4.length !== 4) return false;
    }

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
      await onSave({
        name: formData.name,
        accountKind: formData.accountKind,
        iban: formData.accountKind === "bank_account" ? normalizeIban(formData.iban) : undefined,
        cardBrand: formData.accountKind === "credit_card" ? formData.cardBrand : undefined,
        cardLast4: formData.accountKind === "credit_card" ? formData.cardLast4 : undefined,
        linkedSourceId: formData.accountKind === "credit_card" ? formData.linkedSourceId || undefined : undefined,
        currency: formData.currency,
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className="w-[450px] sm:w-[500px]">
        <SheetHeader>
          <SheetTitle>Edit Account</SheetTitle>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {/* Account Type Selector */}
          <div>
            <label className="text-sm font-medium mb-2 block">
              Account Type
            </label>
            <div className="grid grid-cols-3 gap-2">
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
              <button
                type="button"
                onClick={() => handleAccountKindChange("cash")}
                className={cn(
                  "flex items-center gap-2 p-3 rounded-lg border-2 transition-colors",
                  formData.accountKind === "cash"
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                )}
              >
                <Banknote className="h-5 w-5" />
                <span className="font-medium">{t("cashBox.kind")}</span>
              </button>
            </div>
            {formData.accountKind === "cash" && (
              <p className="text-xs text-muted-foreground mt-2">{t("cashBox.hint")}</p>
            )}
          </div>

          {/* Account Name */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Account Name *
            </label>
            <Input
              placeholder={formData.accountKind === "credit_card"
                ? "e.g., Amex Business Card"
                : formData.accountKind === "cash"
                  ? t("cashBox.namePlaceholder")
                  : "e.g., Business Account"}
              value={formData.name}
              onChange={(e) =>
                setFormData((f) => ({ ...f, name: e.target.value }))
              }
              required
            />
          </div>

          {/* IBAN - Only for bank accounts */}
          {formData.accountKind === "bank_account" && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                IBAN *
              </label>
              <Input
                placeholder="AT12 3456 7890 1234 5678"
                value={formData.iban}
                onChange={(e) => handleIbanChange(e.target.value)}
                onBlur={handleIbanBlur}
                className={ibanError ? "border-destructive" : ""}
                required
              />
              {ibanError && (
                <p className="text-xs text-destructive mt-1">{ibanError}</p>
              )}
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
                  {linkableSources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
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
              {isSubmitting ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
