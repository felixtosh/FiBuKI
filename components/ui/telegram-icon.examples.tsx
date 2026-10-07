import { LifeBuoy, Settings, Users } from "lucide-react";
import { TelegramIcon } from "@/components/ui/telegram-icon";
import type { ComponentDoc } from "@/lib/design-system/types";

function NextToLucide() {
  return (
    <div className="flex items-center gap-4 text-muted-foreground">
      <Settings className="h-4 w-4" />
      <Users className="h-4 w-4" />
      <LifeBuoy className="h-4 w-4" />
      <TelegramIcon className="h-4 w-4" />
      <span className="mx-2 h-4 w-px bg-border" />
      <TelegramIcon className="h-5 w-5 text-foreground" />
      <TelegramIcon className="h-6 w-6 text-foreground" />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "TelegramIcon",
  purpose: "Telegram as a monochrome lucide-style icon, for the community link; not a full-colour logo.",
  layer: "primitive",
  examples: [{ name: "Next to lucide icons", Example: NextToLucide }],
};
export default doc;
