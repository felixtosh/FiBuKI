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
import type { BackCountryRequest, BackCountryResponse } from "@/types/expand";

interface BackCountryDialogProps {
  countryCode: string | null;
  onClose: () => void;
}

export function BackCountryDialog({
  countryCode,
  onClose,
}: BackCountryDialogProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const country = EXPANDABLE_COUNTRIES.find((c) => c.code === countryCode);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!countryCode || !email) return;

    setLoading(true);
    setError(null);

    try {
      const result = await callFunction<BackCountryRequest, BackCountryResponse>(
        "backCountry",
        {
          countryCode,
          email,
          successUrl: `${window.location.origin}/expand?success=${countryCode}`,
          cancelUrl: `${window.location.origin}/expand?country=${countryCode}`,
        }
      );

      // Redirect to Stripe Checkout
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
            {country?.flag} Back FiBuKI in {country?.name}
          </DialogTitle>
          <DialogDescription>
            Pay €10 to help bring FiBuKI to {country?.name}. Your payment will
            be applied as credit toward your first month once the country goes
            live.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="backer-email" className="text-sm font-medium">
              Email address
            </label>
            <Input
              id="backer-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              We&apos;ll notify you when {country?.name} goes live.
            </p>
          </div>

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
