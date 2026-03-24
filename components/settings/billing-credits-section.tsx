"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Coins, Plus } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import {
  addAICreditsCallable,
  updateOverageSettingsCallable,
} from "@/lib/firebase/callable";

export function BillingCreditsSection() {
  const { aiCredits, aiOverageCap, plan, planConfig } = useSubscription();
  const [amount, setAmount] = useState("5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overageSaving, setOverageSaving] = useState(false);

  const handleAddCredits = async () => {
    const amountEur = parseFloat(amount);
    if (isNaN(amountEur) || amountEur < 1 || amountEur > 100) {
      setError("Amount must be between 1 and 100 EUR");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await addAICreditsCallable({
        amountEur,
        successUrl: `${window.location.origin}/settings/billing?credits=success`,
        cancelUrl: `${window.location.origin}/settings/billing`,
      });
      window.location.href = result.checkoutUrl;
    } catch (err: any) {
      setError(err.message || "Failed to start checkout");
      setLoading(false);
    }
  };

  const handleOverageToggle = async (enabled: boolean) => {
    setOverageSaving(true);
    try {
      await updateOverageSettingsCallable({
        overageCapEur: enabled ? 10 : 0,
      });
    } catch (err) {
      console.error("Failed to update overage settings:", err);
    } finally {
      setOverageSaving(false);
    }
  };

  if (plan === "free") return null;

  const overageEnabled = aiOverageCap > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4" />
          <CardTitle className="text-base">AI Credits & Overage</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Credits */}
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold">
              {aiCredits.toFixed(2)} EUR
            </span>
            <span className="text-sm text-muted-foreground">remaining</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Credits are used after your fair-use budget is depleted. They
            don&apos;t expire.
          </p>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min="1"
                max="100"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">EUR</span>
            </div>
            <Button size="sm" onClick={handleAddCredits} disabled={loading}>
              <Plus className="h-4 w-4 mr-1" />
              {loading ? "Redirecting..." : "Add Credits"}
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        {/* Overage toggle */}
        {planConfig.overageAllowed && (
          <div className="border-t pt-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="overage-toggle" className="text-sm font-medium">
                  Overage spending
                </Label>
                <p className="text-xs text-muted-foreground">
                  Allow AI to continue beyond your fair-use budget, up to a
                  monthly cap
                </p>
              </div>
              <Switch
                id="overage-toggle"
                checked={overageEnabled}
                onCheckedChange={handleOverageToggle}
                disabled={overageSaving}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
