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
  type LucideIcon,
} from "lucide-react";
import type { PlanFeatureKey } from "@/types/billing";

export interface SettingsNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  feature?: PlanFeatureKey;
}

export const settingsNavItems: SettingsNavItem[] = [
  { href: "/settings/sign-in-security", label: "Sign-in & Security", icon: Shield },
  { href: "/settings/identity", label: "Your Identity", icon: User },
  { href: "/settings/billing", label: "Billing & Plan", icon: CreditCard },
  { href: "/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/settings/usage", label: "Usage", icon: Activity, feature: "aiMatching" },
  { href: "/settings/categories", label: "Categories", icon: Tag },
  { href: "/settings/integrations", label: "Integrations", icon: Link2, feature: "aiMatching" },
  { href: "/settings/import-export", label: "Import / Export", icon: Download },
  { href: "/settings/referral", label: "Refer a Friend", icon: Gift },
];
