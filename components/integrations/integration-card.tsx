import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface IntegrationCardProps {
  icon: React.ReactNode;
  iconBg: string;
  name: string;
  status: string;
  badge?: {
    label: string;
    variant: "success" | "warning" | "destructive" | "muted";
  };
  href: string;
  comingSoon?: boolean;
}

const badgeVariantMap: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  success: "success",
  warning: "warning",
  destructive: "destructive",
  muted: "muted",
};

export function IntegrationCard({
  icon,
  iconBg,
  name,
  status,
  badge,
  href,
  comingSoon,
}: IntegrationCardProps) {
  const content = (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors",
        comingSoon
          ? "opacity-50 cursor-default"
          : "hover:bg-accent/50 cursor-pointer"
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          iconBg
        )}
      >
        {icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {badge && (
            <Badge
              variant={badgeVariantMap[badge.variant]}
              className="text-xs"
            >
              {badge.label}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{status}</p>
      </div>

      {!comingSoon && (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
    </div>
  );

  if (comingSoon) {
    return content;
  }

  return (
    <Link href={href} className="block">
      {content}
    </Link>
  );
}
