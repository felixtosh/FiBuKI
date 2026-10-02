/**
 * The Telegram invite: the logo can sit in several places at once (settings
 * dropdown, footer, onboarding), so each instance needs its own gradient id,
 * and the homepage footer links to the open announcements channel.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import { TelegramLogo } from "@/components/ui/telegram-logo";
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
  it("gives every logo its own gradient id", () => {
    const { container } = render(
      <>
        <TelegramLogo />
        <TelegramLogo />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(container.querySelector(`circle[fill="url(#${id})"]`)).not.toBeNull();
    }
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
