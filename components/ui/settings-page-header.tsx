import { cn } from "@/lib/utils";

interface SettingsPageHeaderProps {
  title: string;
  description: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Consistent page header for settings pages.
 *
 * Usage:
 * ```tsx
 * <SettingsPageHeader
 *   title="General Settings"
 *   description="Manage how you sign in and protect your account"
 * />
 * ```
 *
 * With actions:
 * ```tsx
 * <SettingsPageHeader
 *   title="AI Usage"
 *   description="Track your AI feature usage and estimated costs"
 * >
 *   <Button>Export</Button>
 * </SettingsPageHeader>
 * ```
 */
export function SettingsPageHeader({
  title,
  description,
  children,
  className,
}: SettingsPageHeaderProps) {
  return (
    <div className={cn("mb-8", children && "flex items-center justify-between", className)}>
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}
