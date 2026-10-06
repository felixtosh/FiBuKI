import { TelegramLogo } from "@/components/ui/telegram-logo";
import type { ComponentDoc } from "@/lib/design-system/types";

function Sizes() {
  return (
    <div className="flex items-center gap-4">
      <TelegramLogo className="h-4 w-4" />
      <TelegramLogo className="h-6 w-6" />
      <TelegramLogo className="h-10 w-10" />
    </div>
  );
}

const doc: ComponentDoc = {
  title: "TelegramLogo",
  purpose: "The Telegram logo for the Telegram integration.",
  layer: "brand",
  examples: [{ name: "Sizes", Example: Sizes }],
};
export default doc;
