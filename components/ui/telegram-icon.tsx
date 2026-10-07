import type { SVGProps } from "react";

/**
 * Telegram as an icon, not a logo: the paper plane on lucide's 24px grid with
 * the same 2px stroke and currentColor, so it sits quietly next to lucide
 * icons (the settings menu, the footer) instead of shouting in brand blue.
 */
export function TelegramIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M21.2 4.4 2.9 11.5c-.9.4-.8 1.6.1 1.9l4.5 1.4 1.8 5.4c.2.7 1.1.9 1.6.4l2.6-2.4 4.6 3.4c.6.4 1.5.1 1.6-.7l3-14.3c.2-.9-.6-1.5-1.5-1.2Z" />
      <path d="m7.5 14.8 10.2-6.6-7.2 6.9" />
    </svg>
  );
}
