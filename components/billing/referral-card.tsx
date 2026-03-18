"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check, Gift, Users, Loader2 } from "lucide-react";
import { callFunction } from "@/lib/firebase/callable";
import type { GetReferralCodeResponse, GetReferralStatsResponse } from "@/types/referral";

export function ReferralCard() {
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<GetReferralStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [codeRes, statsRes] = await Promise.all([
        callFunction<void, GetReferralCodeResponse>("getReferralCode", undefined as never),
        callFunction<void, GetReferralStatsResponse>("getReferralStats", undefined as never),
      ]);
      setReferralCode(codeRes.code);
      setShareUrl(codeRes.shareUrl);
      setStats(statsRes);
    } catch (err) {
      console.error("[ReferralCard] Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center h-32">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4" />
          Refer a Friend
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Share your referral link. They get <strong>€20 off</strong> their first
          yearly plan, and you get <strong>1 free month</strong> when they subscribe.
        </p>

        {/* Share link */}
        <div className="flex gap-2">
          <Input
            readOnly
            value={shareUrl || ""}
            className="font-mono text-sm"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={handleCopy}
            className="shrink-0"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-600" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>

        {/* Stats */}
        {stats && stats.totalReferred > 0 && (
          <div className="flex gap-4 pt-2 text-sm">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              <span>{stats.totalReferred} referred</span>
            </div>
            {stats.converted > 0 && (
              <div className="text-green-600 font-medium">
                {stats.converted} converted
              </div>
            )}
            {stats.totalCreditsEur > 0 && (
              <div className="text-green-600 font-medium">
                €{stats.totalCreditsEur.toFixed(0)} earned
              </div>
            )}
            {stats.pendingCredits > 0 && (
              <div className="text-amber-600">
                {stats.pendingCredits} pending
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Code: <span className="font-mono font-medium">{referralCode}</span>
        </p>
      </CardContent>
    </Card>
  );
}
