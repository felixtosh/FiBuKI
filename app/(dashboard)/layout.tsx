"use client";

import { useEffect, useState, useRef, useCallback, useLayoutEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Receipt, Building2, Users, Settings, Activity, Globe, Files, Tag, Link2, User, LogOut, UserPlus, Palette, Shield, Zap, FileText, FlaskConical, Download, CreditCard, Mail, Bell } from "lucide-react";
import { settingsNavItems } from "@/lib/config/settings-nav";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import Link from "next/link";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { cn } from "@/lib/utils";
import { ChatProvider, ChatSidebar, useChat, WorkerQueueProcessor } from "@/components/chat";
import { ProtectedRoute, useAuth } from "@/components/auth";
import { OnboardingOverlay, OnboardingCompletion } from "@/components/onboarding";
import { useOnboarding } from "@/hooks/use-onboarding";
import { useSubscription } from "@/hooks/use-subscription";
import { BillingLimitBanner } from "@/components/billing/billing-limit-banner";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { logoFont } from "@/app/fonts";
import type { PlanFeatureKey } from "@/types/billing";

const NAV_COMPACT_BREAKPOINT = 635;

const navItems: { href: string; label: string; icon: typeof Receipt; feature?: PlanFeatureKey }[] = [
  { href: "/transactions", label: "Transactions", icon: Receipt },
  { href: "/files", label: "Files", icon: Files, feature: "fileUpload" },
  { href: "/sources", label: "Accounts", icon: Building2 },
  { href: "/partners", label: "Partners", icon: Users, feature: "partnerIntelligence" },
  { href: "/reports", label: "Reports", icon: FileText, feature: "aiMatching" },
];

/**
 * Controller component that syncs onboarding state with chat sidebar mode
 * and renders onboarding-related overlays
 */
function OnboardingController() {
  const { state, loading, isOnboarding, needsWelcome, showCompletion, dismissCompletion } = useOnboarding();
  const { setSidebarMode, toggleSidebar, isSidebarOpen } = useChat();
  const pathname = usePathname();
  const router = useRouter();

  // Redirect to /welcome if track isn't set yet (and not already there)
  useEffect(() => {
    if (loading) return;
    if (
      state &&
      !state.track &&
      !state.isComplete &&
      pathname !== "/welcome"
    ) {
      router.replace("/welcome");
    }
  }, [state, loading, pathname, router]);

  // Sync sidebar mode with onboarding state
  useEffect(() => {
    // Don't show onboarding sidebar until track is selected
    if (needsWelcome || pathname === "/welcome") return;

    if (isOnboarding) {
      setSidebarMode("onboarding");
      // Auto-open sidebar when onboarding
      if (!isSidebarOpen) {
        toggleSidebar();
      }
    } else {
      setSidebarMode("chat");
    }
  }, [isOnboarding, needsWelcome, setSidebarMode, isSidebarOpen, toggleSidebar, pathname]);

  // Handle completion dismissal - switch to chat mode
  const handleDismissCompletion = async () => {
    await dismissCompletion();
    setSidebarMode("chat");
  };

  return (
    <>
      <OnboardingOverlay />
      <OnboardingCompletion
        open={showCompletion ?? false}
        onDismiss={handleDismissCompletion}
      />
    </>
  );
}

function DashboardContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isSidebarOpen, sidebarWidth } = useChat();
  const { user, isAdmin, signOut } = useAuth();
  const { hasFeature, loading: subLoading } = useSubscription();
  const [isLogoJumping, setIsLogoJumping] = useState(false);
  const [isCompactNavigation, setIsCompactNavigation] = useState(false);
  const [hoveredNavItem, setHoveredNavItem] = useState<string | null>(null);

  // Filter nav items based on plan features (show all while loading to prevent flash)
  const visibleNavItems = useMemo(
    () => subLoading
      ? navItems
      : navItems.filter((item) => !item.feature || hasFeature(item.feature)),
    [hasFeature, subLoading]
  );

  const visibleSettingsItems = useMemo(
    () => subLoading
      ? settingsNavItems
      : settingsNavItems.filter((item) => !item.feature || hasFeature(item.feature)),
    [hasFeature, subLoading]
  );

  // Sliding nav indicator
  const navContainerRef = useRef<HTMLDivElement>(null);
  const navRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const navRef = useRef<HTMLElement>(null);
  const [hasMeasured, setHasMeasured] = useState(false);
  const [navIndicatorStyle, setNavIndicatorStyle] = useState<React.CSSProperties>({
    opacity: 0, left: 0, width: 0, height: 0, top: 0,
  });

  const activeIndex = visibleNavItems.findIndex((item) => pathname.startsWith(item.href));

  // Trim navRefs to match the current nav length (in an effect, not during render).
  useEffect(() => {
    navRefs.current.length = visibleNavItems.length;
  }, [visibleNavItems.length]);

  const updateIndicator = useCallback(() => {
    const el = activeIndex >= 0 ? navRefs.current[activeIndex] : null;
    const nav = navRef.current;
    if (el && nav) {
      const navRect = nav.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      setNavIndicatorStyle({
        left: elRect.left - navRect.left,
        width: elRect.width,
        height: elRect.height,
        top: elRect.top - navRect.top,
        opacity: 1,
      });
      setHasMeasured(true);
    } else {
      setNavIndicatorStyle((prev) => ({ ...prev, opacity: 0 }));
    }
  }, [activeIndex, isCompactNavigation, visibleNavItems.length]);

  // Compact nav when header navigation area gets too tight.
  useEffect(() => {
    const navContainer = navContainerRef.current;
    if (!navContainer) return;

    const updateCompactNav = (width: number) => {
      setIsCompactNavigation(width <= NAV_COMPACT_BREAKPOINT);
    };

    updateCompactNav(navContainer.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCompactNav(entry.contentRect.width);
    });

    observer.observe(navContainer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    queueMicrotask(() => setHoveredNavItem(null));
  }, [pathname, isCompactNavigation]);

  // Update indicator on route change and sidebar resize
  useLayoutEffect(() => {
    updateIndicator();
  }, [updateIndicator, sidebarWidth, isSidebarOpen]);

  const handleLogoClick = () => {
    if (!isLogoJumping) {
      setIsLogoJumping(true);
      setTimeout(() => setIsLogoJumping(false), 600);
    }
    router.push("/transactions");
  };

  // Listen for chat:openFile events to navigate to files page
  useEffect(() => {
    const handleOpenFile = (e: CustomEvent<{ fileId: string }>) => {
      const { fileId } = e.detail;
      if (fileId) {
        router.push(`/files?id=${fileId}`);
      }
    };

    window.addEventListener("chat:openFile", handleOpenFile as EventListener);
    return () => {
      window.removeEventListener("chat:openFile", handleOpenFile as EventListener);
    };
  }, [router]);

  // Set CSS variable on document root for dialog centering
  const sidebarOffset = isSidebarOpen ? sidebarWidth : 0;

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-offset", `${sidebarOffset}px`);
  }, [sidebarOffset]);

  return (
    <div
      className="h-screen bg-background transition-all duration-300 ease-in-out overflow-hidden flex flex-col"
      style={{ marginLeft: sidebarOffset }}
    >
      {/* Impersonation banner (admin debugging) */}
      <ImpersonationBanner />

      {/* Billing limit banner */}
      <BillingLimitBanner />

      {/* Header */}
      <header className="border-b bg-card flex-shrink-0 z-50 px-4 h-14 flex items-center">
          <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <div ref={navContainerRef} className="flex min-w-0 flex-1 items-center gap-6">
            <button
              onClick={handleLogoClick}
              className={cn(
                "flex items-center gap-2 hover:opacity-80 logo-wrapper flex-shrink-0",
                isLogoJumping && "is-jumping"
              )}
            >
              <FibukiMascot size={28} className="-my-1" isJumping={isLogoJumping} />
              <span className={cn("font-semibold text-lg mascot-text", logoFont.className)}>
                FiBuKI
              </span>
            </button>
            <nav ref={navRef} className="relative flex min-w-0 items-center gap-1">
              {/* Sliding active indicator */}
              <div
                className={cn(
                  "absolute pointer-events-none rounded-md bg-primary/8",
                  hasMeasured
                    ? "transition-[left,width,opacity] duration-300 ease-out"
                    : "transition-none"
                )}
                style={navIndicatorStyle}
                aria-hidden
              />
              {visibleNavItems.map((item, i) => {
                const isActive = pathname.startsWith(item.href);
                const link = (
                  <Link
                    key={item.href}
                    href={item.href}
                    ref={(el) => { navRefs.current[i] = el; }}
                    className={cn(
                      "relative flex items-center rounded-md text-sm font-medium transition-colors duration-200",
                      isCompactNavigation ? "h-9 w-9 justify-center px-0" : "gap-2 px-3 py-1.5",
                      isActive
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-primary/5"
                    )}
                    onMouseEnter={() => isCompactNavigation && setHoveredNavItem(item.href)}
                    onMouseLeave={() => isCompactNavigation && setHoveredNavItem((prev) => prev === item.href ? null : prev)}
                    onFocus={() => isCompactNavigation && setHoveredNavItem(item.href)}
                    onBlur={() => isCompactNavigation && setHoveredNavItem((prev) => prev === item.href ? null : prev)}
                  >
                    <item.icon className="h-4 w-4" />
                    {isCompactNavigation ? <span className="sr-only">{item.label}</span> : item.label}
                  </Link>
                );

                if (!isCompactNavigation) return link;

                return (
                  <Popover
                    key={item.href}
                    open={hoveredNavItem === item.href}
                    onOpenChange={(open) => setHoveredNavItem(open ? item.href : null)}
                  >
                    <PopoverTrigger asChild>{link}</PopoverTrigger>
                    <PopoverContent
                      className="w-auto px-2 py-1 text-xs"
                      side="bottom"
                      align="center"
                      sideOffset={6}
                    >
                      {item.label}
                    </PopoverContent>
                  </Popover>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="space-y-0.5">
                  <div>Settings</div>
                  {user?.email && (
                    <div className="text-[11px] font-normal text-muted-foreground break-all">
                      {user.email}
                    </div>
                  )}
                </DropdownMenuLabel>
                {visibleSettingsItems.map((item) => (
                  <DropdownMenuItem key={item.href} asChild>
                    <Link href={item.href} className="flex items-center gap-2">
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                ))}

                {isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Admin</DropdownMenuLabel>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/partners" className="flex items-center gap-2">
                        <Globe className="h-4 w-4" />
                        Global Partners
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/usage" className="flex items-center gap-2">
                        <Activity className="h-4 w-4" />
                        AI Usage
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/categories" className="flex items-center gap-2">
                        <Tag className="h-4 w-4" />
                        No-Receipt Categories
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/users" className="flex items-center gap-2">
                        <UserPlus className="h-4 w-4" />
                        Manage Users
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/emails" className="flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        Email Templates
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/automation" className="flex items-center gap-2">
                        <Zap className="h-4 w-4" />
                        Automations
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/admin/testing" className="flex items-center gap-2">
                        <FlaskConical className="h-4 w-4" />
                        Tests
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href="/design-system" className="flex items-center gap-2">
                        <Palette className="h-4 w-4" />
                        Design System
                      </Link>
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => signOut()}
                  className="flex items-center gap-2 text-destructive focus:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>
      </header>

      {/* Main content */}
      <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ProtectedRoute>
      <ChatProvider>
        <OnboardingController />
        <WorkerQueueProcessor />
        <ChatSidebar />
        <DashboardContent>{children}</DashboardContent>
      </ChatProvider>
    </ProtectedRoute>
  );
}
