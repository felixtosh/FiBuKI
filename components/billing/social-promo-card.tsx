"use client";

import { Card, CardContent } from "@/components/ui/card";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { Sparkles, Twitter, Linkedin, ArrowRight } from "lucide-react";

export function SocialPromoCard() {
  return (
    <Card className="relative overflow-hidden border-dashed border-2 border-primary/30 bg-gradient-to-br from-amber-50/50 to-orange-50/50 dark:from-amber-950/20 dark:to-orange-950/20">
      <CardContent className="p-6">
        <div className="flex gap-5 items-start">
          {/* Mascot */}
          <div className="shrink-0 pt-1">
            <div className="rounded-2xl bg-white/80 dark:bg-white/10 p-3 shadow-sm">
              <FibukiMascot size={56} forceFacingRight />
            </div>
          </div>

          {/* Content */}
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              <h3 className="font-semibold text-base">
                Get a free month!
              </h3>
            </div>

            <p className="text-sm text-muted-foreground leading-relaxed">
              Remix the FiBuKI mascot in your own style &mdash; draw it, 3D-print it, make it out of
              gingerbread, we don&apos;t care &mdash; and post it on Twitter or LinkedIn with a mention
              of <span className="font-medium text-foreground">@FiBuKI</span>. We&apos;ll add a free
              month to your plan!
            </p>

            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href="https://x.com/fibukiapp"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-foreground/80 hover:bg-foreground/10 transition-colors"
              >
                <Twitter className="h-3.5 w-3.5" />
                @fibukiapp
                <ArrowRight className="h-3 w-3 opacity-50" />
              </a>
              <a
                href="https://www.linkedin.com/company/fibuki"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-foreground/80 hover:bg-foreground/10 transition-colors"
              >
                <Linkedin className="h-3.5 w-3.5" />
                FiBuKI
                <ArrowRight className="h-3 w-3 opacity-50" />
              </a>
            </div>

            <p className="text-xs text-muted-foreground/70">
              DM us or tag us so we can find your post. One free month per account.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
