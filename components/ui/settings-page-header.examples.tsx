import { Button } from "@/components/ui/button";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";
import type { ComponentDoc } from "@/lib/design-system/types";

function Basic() {
  return (
    <div className="max-w-2xl space-y-6">
      <SettingsPageHeader title="General Settings" description="Your company details and how FiBuKI works for you." />
      <SettingsPageHeader title="Integrations" description="Mailboxes and banks FiBuKI reads from.">
        <Button size="sm">Add</Button>
      </SettingsPageHeader>
    </div>
  );
}

const doc: ComponentDoc = {
  title: "SettingsPageHeader",
  purpose: "The title and description at the top of every settings page, with optional actions.",
  layer: "pattern",
  examples: [{ name: "With and without actions", Example: Basic }],
};
export default doc;
