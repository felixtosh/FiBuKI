"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Coins, Plus } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import { addAICreditsCallable } from "@/lib/firebase/callable";

export function BillingCreditsSection() {
  const { aiCredits, plan } = useSubscription();
  const [amount, setAmount] = useState("5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (plan === "free") return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4" />
          <CardTitle className="text-base">AI Credits</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold">{aiCredits.toFixed(2)} EUR</span>
          <span className="text-sm text-muted-foreground">remaining</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Credits are used after your fair-use budget is depleted. They don&apos;t expire.
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
      </CardContent>
    </Card>
  );
}
