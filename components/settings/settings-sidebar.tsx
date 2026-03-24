"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { settingsNavItems } from "@/lib/config/settings-nav";
import { useSubscription } from "@/hooks/use-subscription";

export function SettingsSidebar() {
  const pathname = usePathname();
  const { hasFeature } = useSubscription();

  const visibleItems = settingsNavItems.filter(
    (item) => !item.feature || hasFeature(item.feature)
  );

  const internalItems = visibleItems.filter((item) => !item.external);
  const externalItems = visibleItems.filter((item) => item.external);

  return (
    <nav className="w-56 border-r bg-muted/30 p-4 shrink-0 overflow-y-auto">
      <h1 className="text-lg font-semibold mb-4">Settings</h1>
      <ul className="space-y-1">
        {internalItems.map((item) => {
          const Icon = item.icon;
          const isActive =
            pathname === item.href ||
            (item.href === "/settings/sign-in-security" && pathname === "/settings") ||
            (item.href === "/settings/categories" && pathname.startsWith("/settings/categories")) ||
            (item.href === "/settings/integrations" && pathname.startsWith("/settings/integrations"));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {externalItems.length > 0 && (
        <>
          <div className="border-t my-3" />
          <ul className="space-y-1">
            {externalItems.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 hover:bg-muted text-muted-foreground hover:text-foreground"
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                    <ExternalLink className="h-3 w-3 ml-auto" />
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </nav>
  );
}
