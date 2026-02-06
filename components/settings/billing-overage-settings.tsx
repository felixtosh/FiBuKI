"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldAlert } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import { updateOverageSettingsCallable } from "@/lib/firebase/callable";

export function BillingOverageSettings() {
  const { aiOverageCap, plan, planConfig } = useSubscription();
  const [enabled, setEnabled] = useState(aiOverageCap > 0);
  const [cap, setCap] = useState(aiOverageCap > 0 ? aiOverageCap.toString() : "10");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!planConfig.overageAllowed) return null;

  const handleSave = async () => {
    const capEur = enabled ? parseFloat(cap) : 0;
    if (enabled && (isNaN(capEur) || capEur < 1 || capEur > 200)) {
      setError("Cap must be between 1 and 200 EUR");
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateOverageSettingsCallable({ overageCapEur: capEur });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message || "Failed to update overage settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" />
          <CardTitle className="text-base">Overage Settings</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Allow AI matching to continue beyond your fair-use budget, up to a monthly cap.
        </p>

        <div className="flex items-center gap-3">
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={() => setEnabled(!enabled)}
          >
            {enabled ? "Enabled" : "Disabled"}
          </Button>
          <span className="text-sm">Overage spending</span>
        </div>

        {enabled && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Max monthly overage:</span>
            <Input
              type="number"
              min="1"
              max="200"
              step="1"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">EUR</span>
          </div>
        )}

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </Button>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
