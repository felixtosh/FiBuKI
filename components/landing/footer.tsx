"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

export function LandingFooter() {
  const t = useTranslations("landing.footer");

  return (
    <footer className="border-t bg-card py-4 px-6 mt-auto">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
        <span className="text-xs">Infinity Vertigo GmbH</span>
        <div className="flex gap-6">
          <a
            href="https://github.com/felixtosh/TaxToolAT"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            {t("contribute")}
          </a>
          <Link
            href="/terms"
            className="hover:text-foreground transition-colors"
          >
            {t("terms")}
          </Link>
          <Link
            href="/privacy"
            className="hover:text-foreground transition-colors"
          >
            {t("privacy")}
          </Link>
          <Link
            href="/impressum"
            className="hover:text-foreground transition-colors"
          >
            {t("impressum")}
          </Link>
        </div>
      </div>
    </footer>
  );
}
