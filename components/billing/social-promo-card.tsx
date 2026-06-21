"use client";

import { Card, CardContent } from "@/components/ui/card";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
// lucide-react v1 dropped the brand glyphs (Twitter → X rebrand, no
// Linkedin export). Use the X glyph for the x.com link; inline SVG
// fallback for LinkedIn.
import { Sparkles, X as XGlyph, ArrowRight } from "lucide-react";

function LinkedinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.95v5.66h-3.55V9h3.41v1.56h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.99 0 1.78-.77 1.78-1.72V1.72C24 .77 23.21 0 22.22 0z" />
    </svg>
  );
}

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
                <XGlyph className="h-3.5 w-3.5" />
                @fibukiapp
                <ArrowRight className="h-3 w-3 opacity-50" />
              </a>
              <a
                href="https://www.linkedin.com/company/fibuki"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1.5 text-xs font-medium text-foreground/80 hover:bg-foreground/10 transition-colors"
              >
                <LinkedinGlyph className="h-3.5 w-3.5" />
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
