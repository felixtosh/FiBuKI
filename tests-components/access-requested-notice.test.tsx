import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import { AccessRequestedNotice } from "@/components/auth/access-requested-notice";

const show = (connecting: boolean, locale: "en" | "de" = "en") =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : de}>
      <AccessRequestedNotice connecting={connecting} />
    </NextIntlClientProvider>
  );

describe("AccessRequestedNotice", () => {
  it("says an admin will review it, for a plain sign-in", () => {
    show(false);
    expect(screen.getByText(/Access request submitted/)).toBeTruthy();
    expect(screen.queryByText(/connect FiBuKI again/)).toBeNull();
  });

  it("tells someone connecting an assistant to come back and connect again once approved", () => {
    show(true);
    expect(screen.getByText("Access requested.")).toBeTruthy();
    expect(screen.getByText(/email you as soon as you are approved/)).toBeTruthy();
    expect(screen.getByText(/connect FiBuKI again/)).toBeTruthy();
  });

  it("speaks German", () => {
    show(true, "de");
    expect(screen.getByText("Zugang angefragt.")).toBeTruthy();
  });
});
