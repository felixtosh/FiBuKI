import {
  Shield,
  User,
  CreditCard,
  Bell,
  Activity,
  Tag,
  Link2,
  Download,
  Gift,
} from "lucide-react";
import type { ComponentType } from "react";
import { TelegramLogo } from "@/components/ui/telegram-logo";
import { COMMUNITY_SETTINGS_PATH } from "@/lib/config/community";
import type { PlanFeatureKey } from "@/types/billing";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  feature?: PlanFeatureKey;
  external?: boolean;
}

export const settingsNavItems: SettingsNavItem[] = [
  { href: "/settings/sign-in-security", label: "General Settings", icon: Shield },
  { href: "/settings/identity", label: "Your Identity", icon: User },
  { href: "/settings/billing", label: "Billing & Plan", icon: CreditCard },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/usage", label: "Usage", icon: Activity, feature: "aiMatching" },
  { href: "/settings/categories", label: "Categories", icon: Tag },
  { href: "/settings/integrations", label: "Integrations", icon: Link2, feature: "aiMatching" },
  { href: "/settings/import-export", label: "Import / Export", icon: Download },
  { href: "/settings/referral", label: "Refer a Friend", icon: Gift },
  { href: COMMUNITY_SETTINGS_PATH, label: "Support & Community", icon: TelegramLogo },
];
