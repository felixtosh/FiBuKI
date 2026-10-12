import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/auth";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { bodyFont, logoFont } from "@/app/fonts";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getLocale } from "next-intl/server";

export const metadata: Metadata = {
  title: "FiBuKI - Your bookkeeping works while you sleep",
  description: "Pre-accounting for Austrian one-person businesses: your receipts and bank lines, ready for your Tax Advisor.",
  openGraph: {
    title: "FiBuKI - Your bookkeeping works while you sleep",
    description: "Pre-accounting for Austrian one-person businesses: your receipts and bank lines, ready for your Tax Advisor.",
    url: "https://fibuki.com",
    siteName: "FiBuKI",
    images: [
      {
        url: "https://fibuki.com/og-image.png",
        width: 1200,
        height: 630,
        alt: "FiBuKI - Your bookkeeping works while you sleep",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FiBuKI - Your bookkeeping works while you sleep",
    description: "Pre-accounting for Austrian one-person businesses: your receipts and bank lines, ready for your Tax Advisor.",
    images: ["https://fibuki.com/og-image.png"],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className="overflow-hidden" suppressHydrationWarning>
      <body
        className={`${bodyFont.className} ${logoFont.variable} overflow-hidden`}
      >
        <ThemeProvider>
          <NextIntlClientProvider messages={messages}>
            <AuthProvider>{children}</AuthProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
