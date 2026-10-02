import type { TaxFile } from "@/types/file";

export type FileSourceKind =
  | "gmail"
  | "forwarding"
  | "invoicing"
  | "browser"
  | "dropbox"
  | "gdrive"
  | "upload";

export type FileSourceIcon = "mail" | "file" | "globe" | "cloud" | "upload";

export interface FileSourceView {
  kind: FileSourceKind;
  icon: FileSourceIcon;
  /** Key under `files.source` for the translated default wording. */
  labelKey: string;
  /** A literal better than the default (mailbox address, domain), else null. */
  text: string | null;
  /** In-app page of the source, else null. */
  href: string | null;
  /** Mail sources get the "Mail" details row. */
  isMail: boolean;
}

export function fileSourceKind(file: TaxFile): FileSourceKind;
export function fileSourceView(file: TaxFile): FileSourceView;
