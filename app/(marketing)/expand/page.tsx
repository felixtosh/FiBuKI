import { Suspense } from "react";
import type { Metadata } from "next";
import { ExpandPageContent } from "@/components/expand/expand-page-content";

export const metadata: Metadata = {
  title: "Expand FiBuKI to Your Country",
  description:
    "Help bring FiBuKI to your country. Back with a one-time €10 commitment and unlock PSD2 banking in your region.",
  openGraph: {
    title: "Help bring FiBuKI to your country",
    description:
      "Back your country with €10 and help us expand across Europe. Your payment becomes credit toward your first month.",
    url: "https://fibuki.com/expand",
    siteName: "FiBuKI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Help bring FiBuKI to your country",
    description:
      "Back your country with €10 and help us expand across Europe.",
  },
};

export default function ExpandPage() {
  return (
    <Suspense>
      <ExpandPageContent />
    </Suspense>
  );
}
