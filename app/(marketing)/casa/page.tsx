import { Metadata } from "next";
import { LanguageToggle } from "@/components/landing/language-toggle";
import Link from "next/link";
import { ArrowLeft, Shield, Lock, Server, Eye, Trash2, FileCheck, AlertTriangle } from "lucide-react";

export const metadata: Metadata = {
  title: "Security Documentation - FiBuKI",
  description: "Security and data handling practices for FiBuKI application - CASA Assessment Documentation",
  robots: "noindex, nofollow",
};

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
            <h1 className="text-3xl font-bold">Security Documentation</h1>
          </div>
          <p className="text-muted-foreground">
            Cloud Application Security Assessment (CASA) - Technical Documentation
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Last updated: January 2026 | Document Version: 1.0
          </p>
        </div>

        {/* Company Info */}
        <section className="mb-12 p-6 bg-muted/50 rounded-lg">
          <h2 className="text-xl font-semibold mb-4">Application Information</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">Application Name</h3>
              <p>FiBuKI</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">Developer</h3>
              <p>Infinity Vertigo GmbH</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">Registered Address</h3>
              <p>Bergwald 43, 2812 Hollenthon, Austria</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">Company Registration</h3>
              <p>FN571837m (Austrian Commercial Register)</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">VAT ID</h3>
              <p>ATU77919424</p>
            </div>
            <div>
              <h3 className="font-medium text-sm text-muted-foreground mb-1">Application URL</h3>
              <p>https://fibuki.com</p>
            </div>
          </div>
        </section>

        {/* Application Purpose */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <FileCheck className="h-5 w-5" />
            Application Purpose
          </h2>
          <div className="prose prose-sm max-w-none text-muted-foreground">
            <p className="mb-4">
              FiBuKI is a bookkeeping pre-accounting software designed to help small business owners and freelancers
              manage their financial documents. The application provides:
            </p>
            <ul className="list-disc pl-6 space-y-2 mb-4">
              <li>Bank transaction management and categorization</li>
              <li>Receipt and invoice organization</li>
              <li>AI-powered automatic matching of receipts to transactions</li>
              <li>Integration with bank accounts via Open Banking (PSD2)</li>
              <li>Gmail integration for searching invoice attachments</li>
            </ul>
            <p>
              The application does not replace professional tax advice or accounting services.
              It is a tool to assist users in organizing their financial documents for subsequent
              processing by tax professionals.
            </p>
          </div>
        </section>

        {/* OAuth Scopes */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Google OAuth Scopes Requested
          </h2>
          <div className="space-y-4">
            <div className="border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <code className="text-sm bg-muted px-2 py-1 rounded">
                  https://www.googleapis.com/auth/gmail.readonly
                </code>
                <span className="text-xs bg-amber-50 text-amber-900 border border-amber-300 px-2 py-1 rounded">Restricted</span>
              </div>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Purpose:</strong> Search and read user&apos;s emails to find invoice and receipt attachments.
              </p>
              <p className="text-sm text-muted-foreground">
                <strong>Justification:</strong> Users need to search their email for PDF invoices and receipts
                to match with bank transactions. This scope allows downloading attachments. We cannot use
                gmail.metadata as it does not provide attachment content access.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <code className="text-sm bg-muted px-2 py-1 rounded">
                  https://www.googleapis.com/auth/userinfo.email
                </code>
                <span className="text-xs bg-green-50 text-green-900 border border-green-300 px-2 py-1 rounded">Non-sensitive</span>
              </div>
              <p className="text-sm text-muted-foreground">
                <strong>Purpose:</strong> Identify the connected Gmail account and display it to the user
                in the integrations settings.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <code className="text-sm bg-muted px-2 py-1 rounded">
                  https://www.googleapis.com/auth/userinfo.profile
                </code>
                <span className="text-xs bg-green-50 text-green-900 border border-green-300 px-2 py-1 rounded">Non-sensitive</span>
              </div>
              <p className="text-sm text-muted-foreground">
                <strong>Purpose:</strong> Display the user&apos;s name in the integration settings for
                account identification.
              </p>
            </div>
          </div>
        </section>

        {/* Data Flow */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Server className="h-5 w-5" />
            Data Flow Architecture
          </h2>

          <div className="bg-muted/30 p-6 rounded-lg font-mono text-sm overflow-x-auto mb-6">
            <pre>{`┌─────────────────┐                    ┌──────────────────┐
│   User Browser  │                    │  Google OAuth    │
│   (fibuki.com)  │                    │  Servers         │
└────────┬────────┘                    └────────┬─────────┘
         │                                      │
         │ 1. User clicks "Connect Gmail"       │
         │─────────────────────────────────────►│
         │                                      │
         │ 2. Google shows consent screen       │
         │◄─────────────────────────────────────│
         │                                      │
         │ 3. User grants permission            │
         │─────────────────────────────────────►│
         │                                      │
         │ 4. Redirect with auth code           │
         │◄─────────────────────────────────────│
         │                                      │
         ▼                                      │
┌─────────────────────────────────────────────────────────────┐
│                    FiBuKI Backend                           │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  /api/gmail/callback                                  │ │
│  │  • Validates state parameter (CSRF protection)        │ │
│  │  • Exchanges auth code for tokens                     │ │
│  │  • Stores encrypted tokens in Firestore               │ │
│  └───────────────────────────────────────────────────────┘ │
│                            │                               │
│                            ▼                               │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Firebase Firestore (europe-west1)                    │ │
│  │  Collection: emailIntegrations/{odcId}                │ │
│  │  • userId (owner reference)                           │ │
│  │  • provider: "gmail"                                  │ │
│  │  • email (connected account)                          │ │
│  │  • accessToken (encrypted)                            │ │
│  │  • refreshToken (encrypted)                           │ │
│  │  • tokenExpiry                                        │ │
│  │  • status: "active" | "paused" | "error"              │ │
│  └───────────────────────────────────────────────────────┘ │
│                            │                               │
│                            ▼                               │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Cloud Functions (searchGmailCallable)                │ │
│  │  • Retrieves tokens from Firestore                    │ │
│  │  • Refreshes access token if expired                  │ │
│  │  • Searches Gmail API with user query                 │ │
│  │  • Returns email metadata + attachment info           │ │
│  │  • Downloads attachments on user request              │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘`}</pre>
          </div>
        </section>

        {/* Data Handling */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Data Collection and Usage
          </h2>

          <div className="space-y-6">
            <div>
              <h3 className="font-semibold mb-2">What Data We Access</h3>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4">Data Type</th>
                    <th className="text-left py-2 pr-4">Access Method</th>
                    <th className="text-left py-2 pr-4">Storage</th>
                    <th className="text-left py-2">Purpose</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground">
                  <tr className="border-b">
                    <td className="py-2 pr-4">Email metadata</td>
                    <td className="py-2 pr-4">Gmail API</td>
                    <td className="py-2 pr-4">Temporary (search session)</td>
                    <td className="py-2">Display search results</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">Email subject</td>
                    <td className="py-2 pr-4">Gmail API</td>
                    <td className="py-2 pr-4">Temporary</td>
                    <td className="py-2">Help identify relevant emails</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">Sender information</td>
                    <td className="py-2 pr-4">Gmail API</td>
                    <td className="py-2 pr-4">Temporary</td>
                    <td className="py-2">Match with transaction partners</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">Email date</td>
                    <td className="py-2 pr-4">Gmail API</td>
                    <td className="py-2 pr-4">Temporary</td>
                    <td className="py-2">Match with transaction dates</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">Attachment metadata</td>
                    <td className="py-2 pr-4">Gmail API</td>
                    <td className="py-2 pr-4">Temporary</td>
                    <td className="py-2">Identify receipt files</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Attachment content</td>
                    <td className="py-2 pr-4">Gmail API</td>
                    <td className="py-2 pr-4">Persistent (if downloaded)</td>
                    <td className="py-2">Store as user&apos;s receipt file</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="font-semibold mb-2">What Data We Do NOT Access or Store</h3>
              <ul className="list-disc pl-6 space-y-1 text-sm text-muted-foreground">
                <li>Full email body content (except for invoice detection heuristics)</li>
                <li>Email drafts or sent emails</li>
                <li>Contact lists or address books</li>
                <li>Calendar data</li>
                <li>Any data from other Google services</li>
                <li>Emails without attachments (filtered out in search)</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Security Measures */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Security Measures
          </h2>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">Token Security</h3>
              <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                <li>OAuth 2.0 with state parameter (CSRF protection)</li>
                <li>Tokens stored server-side only</li>
                <li>Encrypted at rest in Firestore</li>
                <li>Automatic token refresh before expiry</li>
                <li>No tokens exposed to client-side JavaScript</li>
              </ul>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">Data Transmission</h3>
              <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                <li>All connections over HTTPS/TLS 1.3</li>
                <li>Firebase App Check for API protection</li>
                <li>Authenticated Cloud Functions only</li>
                <li>No data sent to third parties</li>
              </ul>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">Access Control</h3>
              <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                <li>Per-user data isolation</li>
                <li>Firebase Authentication required</li>
                <li>Firestore security rules enforce ownership</li>
                <li>Users can only access their own integrations</li>
              </ul>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">Infrastructure</h3>
              <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                <li>Google Cloud Platform (Firebase)</li>
                <li>EU data residency (europe-west1)</li>
                <li>SOC 2 Type II compliant infrastructure</li>
                <li>Automated security updates</li>
              </ul>
            </div>
          </div>
        </section>

        {/* User Controls */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            User Control and Data Deletion
          </h2>

          <div className="space-y-4 text-sm text-muted-foreground">
            <div className="border rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">Disconnect Gmail Integration</h3>
              <p className="mb-2">
                Users can disconnect their Gmail integration at any time from Settings → Integrations.
              </p>
              <p>
                <strong>When disconnected:</strong> OAuth tokens are immediately deleted from our database.
                Users should also revoke access from their Google Account security settings.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">Delete Downloaded Files</h3>
              <p>
                Users can delete any files downloaded from Gmail at any time. Deleted files are
                soft-deleted initially and permanently removed after 30 days, or immediately upon
                permanent deletion request.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">Delete Account</h3>
              <p>
                Users can delete their entire account from Settings. This removes all data including:
                all integrations, tokens, files, transactions, and personal information.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold text-foreground mb-2">Google Account Security</h3>
              <p>
                Users can review and revoke FiBuKI&apos;s access at any time via:
                <br />
                <a
                  href="https://myaccount.google.com/permissions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  https://myaccount.google.com/permissions
                </a>
              </p>
            </div>
          </div>
        </section>

        {/* Compliance */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Compliance and Certifications
          </h2>

          <div className="space-y-4">
            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">GDPR Compliance</h3>
              <p className="text-sm text-muted-foreground">
                FiBuKI is operated by an Austrian company and fully complies with the EU General Data
                Protection Regulation (GDPR). Users have rights to access, rectify, erase, and port
                their data as detailed in our Privacy Policy.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">Google API Services User Data Policy</h3>
              <p className="text-sm text-muted-foreground">
                FiBuKI&apos;s use of Google APIs complies with the
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline mx-1"
                >
                  Google API Services User Data Policy
                </a>
                including the Limited Use requirements.
              </p>
            </div>

            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">Infrastructure Compliance</h3>
              <p className="text-sm text-muted-foreground">
                Our infrastructure provider (Google Cloud / Firebase) maintains: SOC 1, SOC 2, SOC 3,
                ISO 27001, ISO 27017, ISO 27018, and PCI DSS certifications.
              </p>
            </div>
          </div>
        </section>

        {/* Limited Use Disclosure */}
        <section className="mb-12 p-6 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-900">
          <h2 className="text-xl font-semibold mb-4">Google API Limited Use Disclosure</h2>
          <p className="text-sm text-muted-foreground mb-4">
            FiBuKI&apos;s use and transfer to any other app of information received from Google APIs
            will adhere to the{" "}
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
          <p className="text-sm text-muted-foreground">
            Specifically, we:
          </p>
          <ul className="list-disc pl-6 mt-2 space-y-1 text-sm text-muted-foreground">
            <li>Only use Gmail data for providing the email search and attachment download features</li>
            <li>Do not use Gmail data for advertising purposes</li>
            <li>Do not transfer Gmail data to third parties except as necessary to provide the service</li>
            <li>Do not use Gmail data for training AI/ML models unrelated to the user&apos;s direct benefit</li>
            <li>Allow users to delete their Gmail data at any time</li>
          </ul>
        </section>

        {/* Contact */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4">Security Contact</h2>
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground mb-4">
              For security-related inquiries or to report vulnerabilities:
            </p>
            <div className="space-y-2 text-sm">
              <p><strong>Company:</strong> Infinity Vertigo GmbH</p>
              <p><strong>Address:</strong> Bergwald 43, 2812 Hollenthon, Austria</p>
              <p><strong>Privacy Policy:</strong> <a href="/privacy" className="text-primary hover:underline">https://fibuki.com/privacy</a></p>
              <p><strong>Terms of Service:</strong> <a href="/terms" className="text-primary hover:underline">https://fibuki.com/terms</a></p>
            </div>
          </div>
        </section>

        {/* Version History */}
        <section className="text-sm text-muted-foreground">
          <h2 className="text-lg font-semibold mb-2 text-foreground">Document History</h2>
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 pr-4">Version</th>
                <th className="text-left py-2 pr-4">Date</th>
                <th className="text-left py-2">Changes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-2 pr-4">1.0</td>
                <td className="py-2 pr-4">January 2026</td>
                <td className="py-2">Initial documentation for CASA assessment</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
