"use client";

import { useState } from "react";
import { Key, ChevronDown, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useApiKeys } from "@/hooks/use-api-keys";
import {
  ApiKeyRowCompact,
  CopyableCommand,
  CreateApiKeyDialog,
  KeyShownDialog,
  CreateKeyButton,
} from "@/components/settings/api-key-primitives";
import { cn } from "@/lib/utils";

export function ApiKeysInline() {
  const { keys, loading, createKey, revokeKey } = useApiKeys();
  const [open, setOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isKeyShownDialog, setIsKeyShownDialog] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Default open if no keys exist
  const isOpen = keys.length === 0 ? true : open;

  const handleRevoke = async (keyId: string) => {
    setRevokingId(keyId);
    try {
      await revokeKey(keyId);
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setOpen}>
        <div className="rounded-lg border bg-card">
          <CollapsibleTrigger className="flex items-center justify-between w-full px-4 py-3 hover:bg-accent/50 transition-colors rounded-lg">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/40">
                <Key className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="text-left">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">API Keys</span>
                  {keys.length > 0 && (
                    <Badge variant="success" className="text-xs">
                      {keys.length} active
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {loading
                    ? "Loading..."
                    : keys.length === 0
                      ? "Create a key to connect AI tools"
                      : `${keys.length} key${keys.length !== 1 ? "s" : ""} configured`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div onClick={(e) => e.stopPropagation()}>
                <CreateKeyButton
                  onClick={() => setIsCreateDialogOpen(true)}
                  disabled={keys.length >= 5}
                />
              </div>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  isOpen && "rotate-180"
                )}
              />
            </div>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="px-4 pb-4 pt-1 border-t">
              {keys.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground">
                  <Key className="h-6 w-6 mx-auto mb-1.5 opacity-50" />
                  <p className="text-xs">No API keys yet</p>
                </div>
              ) : (
                <div className="divide-y">
                  {keys.map((key) => (
                    <ApiKeyRowCompact
                      key={key.id}
                      apiKey={key}
                      onRevoke={() => handleRevoke(key.id)}
                      revoking={revokingId === key.id}
                    />
                  ))}
                </div>
              )}

              <div className="mt-3 pt-3 border-t">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <Terminal className="h-3 w-3" />
                  <span>Or create via CLI:</span>
                </div>
                <CopyableCommand command="npx @fibukiapp/cli auth" />
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <CreateApiKeyDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onCreated={(key) => {
          setNewKeyValue(key);
          setIsKeyShownDialog(true);
        }}
        createKey={createKey}
        keyCount={keys.length}
      />

      <KeyShownDialog
        open={isKeyShownDialog}
        onClose={() => {
          setIsKeyShownDialog(false);
          setNewKeyValue("");
        }}
        keyValue={newKeyValue}
      />
    </>
  );
}
