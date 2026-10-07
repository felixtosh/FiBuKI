/**
 * The Telegram invite: the icon sits next to lucide icons (settings menu,
 * footer, onboarding), so it draws in currentColor like them, and the homepage
 * footer links to the open announcements channel.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import { TelegramIcon } from "@/components/ui/telegram-icon";
import { LandingFooter } from "@/components/landing/footer";
import { TELEGRAM_ANNOUNCEMENTS_URL } from "@/lib/config/community";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("Telegram invite", () => {
  it("draws in the text colour, like a lucide icon, with no colours of its own", () => {
    const { container } = render(<TelegramIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(container.querySelector("linearGradient, [fill^='#'], [stroke^='#']")).toBeNull();
  });

  it("links the homepage footer to the announcements channel", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LandingFooter />
      </NextIntlClientProvider>,
    );
    const link = screen.getByRole("link", { name: "Join us on Telegram" });
    expect(link.getAttribute("href")).toBe(TELEGRAM_ANNOUNCEMENTS_URL);
  });
});
