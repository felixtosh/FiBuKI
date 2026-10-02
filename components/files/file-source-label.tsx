"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ExternalLink, FileText, Mail, Upload } from "lucide-react";
import { InfoPopover } from "@/components/ui/info-popover";
import { cn } from "@/lib/utils";
import type { TaxFile } from "@/types/file";

type FileSourceKind = "gmail" | "forwarding" | "invoicing" | "upload";

function fileSourceKind(file: TaxFile): FileSourceKind {
  if (file.sourceType?.startsWith("gmail")) return "gmail";
  if (file.sourceType?.startsWith("email_inbound")) return "forwarding";
  if (file.sourceType === "fibuki_invoice" || file.invoiceId || file.isFibukiGenerated) {
    return "invoicing";
  }
  return "upload";
}

const ICONS = { gmail: Mail, forwarding: Mail, invoicing: FileText, upload: Upload };

/**
 * Where a File came from, worded and iconed the same in the Files list and the
 * File detail panel: the mailbox address for a mail import, "Email
 * forwarding", "Rechnungserstellung" for a FiBuKI-issued invoice, or "Upload".
 * `linked` makes a mail source a link to its integration (the detail panel).
 */
export function FileSourceLabel({
  file,
  linked = false,
  className,
}: {
  file: TaxFile;
  linked?: boolean;
  className?: string;
}) {
  const t = useTranslations("files.source");
  const kind = fileSourceKind(file);
  const text =
    kind === "gmail"
      ? file.gmailIntegrationEmail || t("gmail")
      : kind === "forwarding"
        ? t("forwarding")
        : kind === "invoicing"
          ? t("invoicing")
          : t("upload");
  const href =
    kind === "gmail" && file.gmailIntegrationId
      ? `/integrations/${file.gmailIntegrationId}`
      : kind === "forwarding"
        ? "/integrations/email-inbound"
        : null;

  const classes = cn("inline-flex items-center gap-1.5 min-w-0", className);
  const asLink = linked && href !== null;

  return asLink ? (
    <Link href={href as string} className={cn(classes, "hover:text-foreground transition-colors")}>
      <SourceContent kind={kind} text={text} external />
    </Link>
  ) : (
    <span className={classes}>
      <SourceContent kind={kind} text={text} />
    </span>
  );
}

function SourceContent({ kind, text, external = false }: { kind: FileSourceKind; text: string; external?: boolean }) {
  const Icon = ICONS[kind];
  return (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{text}</span>
      {external && <ExternalLink className="h-3 w-3 shrink-0" />}
    </>
  );
}

/**
 * How a mail import was found, as one comma-separated line: who sent it, the
 * subject (forwarded mail), the search that found it, and what part of the
 * mail became the File. Null for a File that did not come from mail.
 */
export function useFileMailDetails(file: TaxFile): string | null {
  const t = useTranslations("files.source");
  const kind = fileSourceKind(file);
  if (kind !== "gmail" && kind !== "forwarding") return null;

  const parts: string[] = [];
  if (kind === "gmail" && file.gmailSenderEmail) parts.push(file.gmailSenderEmail);
  if (kind === "forwarding" && file.inboundFrom) {
    parts.push(file.inboundFromName ? `${file.inboundFromName} <${file.inboundFrom}>` : file.inboundFrom);
  }
  if (kind === "forwarding" && file.inboundSubject) parts.push(`„${file.inboundSubject}“`);
  if (file.sourceSearchPattern) parts.push(t("search", { pattern: file.sourceSearchPattern }));
  switch (file.sourceResultType) {
    case "gmail_attachment":
      parts.push(t("resultAttachment"));
      break;
    case "gmail_html_invoice":
      parts.push(t("resultMailBody"));
      break;
    case "gmail_invoice_link":
      parts.push(t("resultLink"));
      break;
    case "local_file":
      parts.push(t("resultLocalFile"));
      break;
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** What the mail details line means, behind its label. */
export function FileMailDetailsInfo() {
  const t = useTranslations("files.source");
  return (
    <InfoPopover label={t("detailsInfoLabel")}>
      <div className="space-y-2 text-xs">
        <p>{t("detailsInfoIntro")}</p>
        <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
          <li>{t("detailsInfoSender")}</li>
          <li>{t("detailsInfoSearch")}</li>
          <li>{t("detailsInfoResult")}</li>
        </ul>
      </div>
    </InfoPopover>
  );
}
