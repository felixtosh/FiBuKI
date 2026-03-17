"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EXPANDABLE_COUNTRIES } from "@/types/expand";
import { callFunction } from "@/lib/firebase/callable";
import { useAuth } from "@/components/auth";
import type { BackCountryRequest, BackCountryResponse } from "@/types/expand";

interface BackCountryDialogProps {
  countryCode: string | null;
  onClose: () => void;
}

export function BackCountryDialog({
  countryCode,
  onClose,
}: BackCountryDialogProps) {
  const { user } = useAuth();
  const userEmail = user?.email ?? "";
  const [manualEmail, setManualEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = userEmail || manualEmail;
  const country = EXPANDABLE_COUNTRIES.find((c) => c.code === countryCode);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!countryCode || !email) return;

    setLoading(true);
    setError(null);

    const slug = countryCode.toLowerCase();

    try {
      const result = await callFunction<BackCountryRequest, BackCountryResponse>(
        "backCountry",
        {
          countryCode,
          email,
          successUrl: `${window.location.origin}/expand/${slug}?success=1`,
          cancelUrl: `${window.location.origin}/expand/${slug}`,
        }
      );

      window.location.href = result.checkoutUrl;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      setLoading(false);
    }
  }

  return (
    <Dialog open={!!countryCode} onOpenChange={() => onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {country?.flag} Unlock PSD2 banking in {country?.name}
          </DialogTitle>
          <DialogDescription>
            Pay €10 to help activate PSD2 banking in {country?.name}. Your
            €10 covers your entire first month once bank connections go live.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {userEmail ? (
            <p className="text-sm text-muted-foreground">
              Backing as <span className="font-medium text-foreground">{userEmail}</span>
            </p>
          ) : (
            <div className="space-y-2">
              <label htmlFor="backer-email" className="text-sm font-medium">
                Email address
              </label>
              <Input
                id="backer-email"
                type="email"
                placeholder="you@example.com"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                We&apos;ll notify you when {country?.name} goes live.
              </p>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !email}>
              {loading ? "Redirecting..." : "Continue to Payment — €10"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
