"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Receipt, Building2, Users, Settings, Activity, Globe, Files, Tag, Link2, User, LogOut, UserPlus, Palette, Shield, Zap, FileText, FlaskConical, Download } from "lucide-react";
import Link from "next/link";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { cn } from "@/lib/utils";
import { ChatProvider, ChatSidebar, useChat, WorkerQueueProcessor } from "@/components/chat";
import { ProtectedRoute, useAuth } from "@/components/auth";
import { OnboardingOverlay, OnboardingCompletion } from "@/components/onboarding";
import { useOnboarding } from "@/hooks/use-onboarding";
import { logoFont } from "@/app/fonts";

const navItems = [
  { href: "/transactions", label: "Transactions", icon: Receipt },
  { href: "/files", label: "Files", icon: Files },
  { href: "/sources", label: "Accounts", icon: Building2 },
  { href: "/partners", label: "Partners", icon: Users },
  { href: "/reports", label: "Reports", icon: FileText },
];

/**
 * Controller component that syncs onboarding state with chat sidebar mode
 * and renders onboarding-related overlays
 */
function OnboardingController() {
  const { isOnboarding, showCompletion, dismissCompletion } = useOnboarding();
  const { setSidebarMode, toggleSidebar, isSidebarOpen } = useChat();

  // Sync sidebar mode with onboarding state
  useEffect(() => {
    if (isOnboarding) {
      setSidebarMode("onboarding");
      // Auto-open sidebar when onboarding
      if (!isSidebarOpen) {
        toggleSidebar();
      }
    } else {
      setSidebarMode("chat");
    }
  }, [isOnboarding, setSidebarMode, isSidebarOpen, toggleSidebar]);

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
  const [isLogoJumping, setIsLogoJumping] = useState(false);

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
      className="h-screen bg-background transition-all duration-300 ease-in-out overflow-hidden"
      style={{ marginLeft: sidebarOffset }}
    >
      {/* Header */}
      <header className="border-b bg-card sticky top-0 z-50 px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <button
              onClick={handleLogoClick}
              className={cn(
                "flex items-center gap-2 hover:opacity-80 logo-wrapper",
                isLogoJumping && "is-jumping"
              )}
            >
              <FibukiMascot size={28} className="-my-1" isJumping={isLogoJumping} />
              <span className={cn("font-semibold text-lg mascot-text", logoFont.className)}>
                FiBuKI
              </span>
            </button>
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/8 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-primary/5"
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded truncate max-w-[200px]">
              {user?.email}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Settings</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href="/settings/sign-in-security" className="flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    Sign-in & Security
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/identity" className="flex items-center gap-2">
                    <User className="h-4 w-4" />
                    Your Identity
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/categories" className="flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    No-Receipt Categories
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/integrations" className="flex items-center gap-2">
                    <Link2 className="h-4 w-4" />
                    Integrations
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/import-export" className="flex items-center gap-2">
                    <Download className="h-4 w-4" />
                    Import / Export
                  </Link>
                </DropdownMenuItem>

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
      </header>

      {/* Main content */}
      <main className="h-[calc(100vh-3.5rem)] overflow-hidden">{children}</main>
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
