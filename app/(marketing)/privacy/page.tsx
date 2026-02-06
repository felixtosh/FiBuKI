import { getTranslations } from "next-intl/server";
import { LanguageToggle } from "@/components/landing/language-toggle";
import { LandingFooter } from "@/components/landing/footer";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Services listed in privacy policy - update this array when adding new services
const SERVICES = [
  "firebase",
  "gmailApi",
  "cloudVision",
  "vertexAi",
  "anthropic",
  "truelayer",
  "gocardless",
  "langfuse",
] as const;

export default async function PrivacyPage() {
  const t = await getTranslations("privacy");
  const common = await getTranslations("common");

  return (
    <>
      <main className="flex-1 py-12 px-4">
        <div className="max-w-2xl mx-auto">
          {/* Back link and language toggle */}
          <div className="flex items-center justify-between mb-8">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              {common("back")}
            </Link>
            <LanguageToggle />
          </div>

          <h1 className="text-3xl font-bold mb-2">{t("title")}</h1>
          <p className="text-sm text-muted-foreground mb-8">
            {t("lastUpdated", { date: "Februar 2026" })}
          </p>

          <p className="text-muted-foreground mb-8">{t("intro")}</p>

          <div className="space-y-8">
            {/* Responsible */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.responsible.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.responsible.content")}
              </p>
            </section>

            {/* Data Collection */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.dataCollection.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.dataCollection.content")}
              </p>
            </section>

            {/* Legal Basis */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.legalBasis.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.legalBasis.content")}
              </p>
            </section>

            {/* Third-Party Services */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.services.title")}
              </h2>
              <p className="text-muted-foreground mb-4">
                {t("sections.services.intro")}
              </p>
              <div className="space-y-4">
                {SERVICES.map((service) => (
                  <div key={service} className="border-l-2 border-muted pl-4">
                    <h3 className="font-medium">
                      {t(`sections.services.${service}.name`)}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t(`sections.services.${service}.purpose`)}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* Google User Data */}
            <section className="rounded-lg border border-blue-200 bg-blue-50/50 p-6 dark:border-blue-900 dark:bg-blue-950/30">
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.googleUserData.title")}
              </h2>
              <p className="text-muted-foreground mb-4">
                {t("sections.googleUserData.content")}
              </p>
              <div className="space-y-4">
                <div className="border-l-2 border-blue-300 pl-4 dark:border-blue-800">
                  <h3 className="font-medium">
                    {t("sections.googleUserData.whatWeAccess.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {t("sections.googleUserData.whatWeAccess.content")}
                  </p>
                </div>
                <div className="border-l-2 border-blue-300 pl-4 dark:border-blue-800">
                  <h3 className="font-medium">
                    {t("sections.googleUserData.howWeUse.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {t("sections.googleUserData.howWeUse.content")}
                  </p>
                </div>
                <div className="border-l-2 border-blue-300 pl-4 dark:border-blue-800">
                  <h3 className="font-medium">
                    {t("sections.googleUserData.limitedUse.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {t("sections.googleUserData.limitedUse.content")}
                  </p>
                </div>
                <div className="border-l-2 border-blue-300 pl-4 dark:border-blue-800">
                  <h3 className="font-medium">
                    {t("sections.googleUserData.revocation.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {t("sections.googleUserData.revocation.content")}
                  </p>
                </div>
              </div>
            </section>

            {/* International Data Transfers */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.internationalTransfers.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.internationalTransfers.content")}
              </p>
            </section>

            {/* Data Protection */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.dataProtection.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line mb-4">
                {t("sections.dataProtection.content")}
              </p>
              <div className="space-y-4">
                <div className="border-l-2 border-muted pl-4">
                  <h3 className="font-medium">
                    {t("sections.dataProtection.emailData.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {t("sections.dataProtection.emailData.content")}
                  </p>
                </div>
                <div className="border-l-2 border-muted pl-4">
                  <h3 className="font-medium">
                    {t("sections.dataProtection.retention.title")}
                  </h3>
                  <p className="text-sm text-muted-foreground whitespace-pre-line">
                    {t("sections.dataProtection.retention.content")}
                  </p>
                </div>
              </div>
            </section>

            {/* Automated Processing */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.automatedProcessing.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.automatedProcessing.content")}
              </p>
            </section>

            {/* Rights */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.rights.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.rights.content")}
              </p>
            </section>

            {/* Contact */}
            <section>
              <h2 className="text-xl font-semibold mb-3">
                {t("sections.contact.title")}
              </h2>
              <p className="text-muted-foreground whitespace-pre-line">
                {t("sections.contact.content")}
              </p>
            </section>
          </div>
        </div>
      </main>

      <LandingFooter />
    </>
  );
}
