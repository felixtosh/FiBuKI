import { Metadata } from "next";
import { LanguageToggle } from "@/components/landing/language-toggle";
import Link from "next/link";
import {
  ArrowLeft,
  Shield,
  Lock,
  FileText,
  FileCheck,
  ExternalLink,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Security & Compliance - FiBuKI",
  description:
    "FiBuKI security and data handling practices. CASA Tier 2 assessment documentation hub.",
  robots: "noindex, nofollow",
};

const REPO_DOCS =
  "https://github.com/felixtosh/TaxToolAT/blob/main/docs/casa";

const artifacts: Array<{
  num: string;
  title: string;
  href: string;
  desc: string;
}> = [
  {
    num: "01",
    title: "Security Architecture",
    href: `${REPO_DOCS}/01-security-architecture.md`,
    desc: "Trust boundaries, authentication flows, data-protection layers, monitoring.",
  },
  {
    num: "02",
    title: "PII Data Flow",
    href: `${REPO_DOCS}/02-pii-data-flow.md`,
    desc: "Entry points, storage locations, access matrix, egress, retention summary.",
  },
  {
    num: "03",
    title: "OAuth Scope Justification",
    href: `${REPO_DOCS}/03-oauth-scope-justification.md`,
    desc: "Why gmail.readonly, minimum-scope argument, runtime minimisation, Limited Use compliance.",
  },
  {
    num: "04",
    title: "Data Retention Policy",
    href: `${REPO_DOCS}/04-data-retention-policy.md`,
    desc: "Retention table per data class, deletion procedures, backup rollover.",
  },
  {
    num: "05",
    title: "Tier 2 Checklist (ASVS v4.0)",
    href: `${REPO_DOCS}/05-tier2-checklist.md`,
    desc: "Per-control status (MET / PARTIAL / N-A / TODO) with evidence pointers.",
  },
  {
    num: "06",
    title: "Self-Assessment Questionnaire",
    href: `${REPO_DOCS}/06-saq.md`,
    desc: "Responses to the 54 CASA Tier 2 non-functional control questions.",
  },
  {
    num: "07",
    title: "SAST Remediation Report",
    href: `${REPO_DOCS}/07-sast-remediation-report.md`,
    desc: "Static-analysis findings, fixes, and re-scan evidence.",
  },
  {
    num: "08",
    title: "DAST Remediation Report",
    href: `${REPO_DOCS}/08-dast-remediation-report.md`,
    desc: "OWASP ZAP and Fluid Attacks dynamic-scan findings and remediation.",
  },
];

export default function CasaPage() {
  return (
    <main className="flex-1 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          <LanguageToggle />
        </div>

        {/* Title */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <Shield className="h-8 w-8 text-primary" />
            <h1 className="text-3xl font-bold">Security &amp; Compliance</h1>
          </div>
          <p className="text-muted-foreground">
            CASA Tier 2 assessment hub for FiBuKI.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Document set version 2.0 · Last updated 2026-06-21
          </p>
        </div>

        {/* Application info */}
        <section className="mb-12 p-6 bg-muted/50 rounded-lg">
          <h2 className="text-xl font-semibold mb-4">Application</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">
                Application
              </h3>
              <p>FiBuKI — https://fibuki.com</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">
                Operator
              </h3>
              <p>Infinity Vertigo GmbH</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">
                Registered address
              </h3>
              <p>Bergwald 43, 2812 Hollenthon, Austria</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">
                Company registration
              </h3>
              <p>FN571837m (Austrian Commercial Register)</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">
                VAT ID
              </h3>
              <p>ATU77919424</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">
                Restricted scope
              </h3>
              <p className="font-mono text-sm">
                gmail.readonly (CASA Tier 2 in progress)
              </p>
            </div>
          </div>
        </section>

        {/* OAuth scopes summary */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Google OAuth Scopes
          </h2>
          <div className="space-y-4">
            <div className="border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <code className="text-sm bg-muted px-2 py-1 rounded">
                  https://www.googleapis.com/auth/gmail.readonly
                </code>
                <span className="text-xs bg-amber-50 text-amber-900 border border-amber-300 px-2 py-1 rounded">
                  Restricted
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Used to search the user&apos;s mailbox for invoice attachments
                and download those the user selects. Full justification and
                minimum-scope analysis in the OAuth Scope Justification document
                below.
              </p>
            </div>
            <div className="border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <code className="text-sm bg-muted px-2 py-1 rounded">
                  https://www.googleapis.com/auth/userinfo.email
                </code>
                <span className="text-xs bg-green-50 text-green-900 border border-green-300 px-2 py-1 rounded">
                  Non-sensitive
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Identify and display the connected Gmail account in the
                integration settings.
              </p>
            </div>
            <div className="border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <code className="text-sm bg-muted px-2 py-1 rounded">
                  https://www.googleapis.com/auth/userinfo.profile
                </code>
                <span className="text-xs bg-green-50 text-green-900 border border-green-300 px-2 py-1 rounded">
                  Non-sensitive
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Display the user&apos;s name in the integration settings for
                account identification.
              </p>
            </div>
          </div>
        </section>

        {/* Limited Use Disclosure */}
        <section className="mb-12 p-6 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-900">
          <h2 className="text-xl font-semibold mb-4">
            Google API Limited Use Disclosure
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            FiBuKI&apos;s use and transfer to any other app of information
            received from Google APIs adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
          <p className="text-sm text-muted-foreground">Specifically, we:</p>
          <ul className="list-disc pl-6 mt-2 space-y-1 text-sm text-muted-foreground">
            <li>
              Only use Gmail data for the email-search and attachment-download
              features the user initiated.
            </li>
            <li>Do not use Gmail data for advertising purposes.</li>
            <li>
              Do not transfer Gmail data to third parties except as strictly
              necessary to provide the service.
            </li>
            <li>
              Do not use Gmail data for training AI/ML models unrelated to the
              user&apos;s direct benefit.
            </li>
            <li>Allow users to delete their Gmail-derived data at any time.</li>
            <li>
              Humans do not access user mail except for security or legal
              purposes, or with explicit consent.
            </li>
          </ul>
        </section>

        {/* Artifacts */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Assessment Artifacts
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            The CASA Tier 2 documentation set is maintained as markdown in the
            public source repository so changes are version-controlled and
            reviewable. Click through to read each document.
          </p>
          <div className="space-y-3">
            {artifacts.map((a) => (
              <a
                key={a.num}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block border rounded-lg p-4 hover:bg-muted/30 transition-colors group"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground">
                      {a.num}
                    </span>
                    <h3 className="font-semibold group-hover:text-primary transition-colors">
                      {a.title}
                    </h3>
                  </div>
                  <ExternalLink className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <p className="text-sm text-muted-foreground pl-8">{a.desc}</p>
              </a>
            ))}
          </div>
        </section>

        {/* Related policies */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <FileCheck className="h-5 w-5" />
            Companion Documents
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            <Link
              href="/privacy"
              className="border rounded-lg p-4 hover:bg-muted/30 transition-colors"
            >
              <h3 className="font-semibold mb-1">Privacy Policy</h3>
              <p className="text-sm text-muted-foreground">
                GDPR-compliant policy, subprocessor list, user rights.
              </p>
            </Link>
            <Link
              href="/terms"
              className="border rounded-lg p-4 hover:bg-muted/30 transition-colors"
            >
              <h3 className="font-semibold mb-1">Terms of Service</h3>
              <p className="text-sm text-muted-foreground">
                Contractual terms, Austrian law, limitation of liability.
              </p>
            </Link>
            <Link
              href="/impressum"
              className="border rounded-lg p-4 hover:bg-muted/30 transition-colors"
            >
              <h3 className="font-semibold mb-1">Impressum</h3>
              <p className="text-sm text-muted-foreground">
                Austrian commercial-register information, operator contact.
              </p>
            </Link>
            <a
              href="/.well-known/security.txt"
              className="border rounded-lg p-4 hover:bg-muted/30 transition-colors"
            >
              <h3 className="font-semibold mb-1">security.txt</h3>
              <p className="text-sm text-muted-foreground">
                RFC 9116 vulnerability disclosure contact.
              </p>
            </a>
          </div>
        </section>

        {/* Contact */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4">Security Contact</h2>
          <div className="border rounded-lg p-4">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <strong>Company:</strong> Infinity Vertigo GmbH
              </p>
              <p>
                <strong>Address:</strong> Bergwald 43, 2812 Hollenthon, Austria
              </p>
              <p>
                <strong>Email:</strong>{" "}
                <a
                  href="mailto:hello@fibuki.com"
                  className="text-primary hover:underline"
                >
                  hello@fibuki.com
                </a>{" "}
                (subject prefix <code>[Security]</code>)
              </p>
              <p>
                Coordinated-disclosure policy:{" "}
                <a
                  href="https://github.com/felixtosh/TaxToolAT/blob/main/SECURITY.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  SECURITY.md
                </a>
              </p>
            </div>
          </div>
        </section>

        {/* Version history */}
        <section className="text-sm text-muted-foreground">
          <h2 className="text-lg font-semibold mb-2 text-foreground">
            Document History
          </h2>
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 pr-4">Version</th>
                <th className="text-left py-2 pr-4">Date</th>
                <th className="text-left py-2">Changes</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="py-2 pr-4">1.0</td>
                <td className="py-2 pr-4">January 2026</td>
                <td className="py-2">Initial single-page documentation.</td>
              </tr>
              <tr>
                <td className="py-2 pr-4">2.0</td>
                <td className="py-2 pr-4">June 2026</td>
                <td className="py-2">
                  Split into eight standalone artifacts per CASA Tier 2 best
                  practice; this page is now the hub.
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
