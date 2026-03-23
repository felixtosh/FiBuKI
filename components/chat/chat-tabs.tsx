"use client";

import { Bell, MessageSquare, X, Plus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ChatTab } from "@/types/chat";

interface ChatTabsProps {
  activeTab: ChatTab;
  onTabChange: (tab: ChatTab) => void;
  onNewChat: () => void;
  onClose: () => void;
}

export function ChatTabs({
  activeTab,
  onTabChange,
  onNewChat,
  onClose,
}: ChatTabsProps) {
  return (
    <TooltipProvider>
      <div className="flex items-center justify-between border-b px-2 h-14">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onTabChange("notifications")}
                aria-label="Activity"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  activeTab === "notifications"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Bell className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Activity</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onTabChange("chat")}
                aria-label="Chat"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  activeTab === "chat"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <MessageSquare className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Chat</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onTabChange("history")}
                aria-label="History"
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  activeTab === "history"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <History className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">History</TooltipContent>
          </Tooltip>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewChat}
            title="New Chat"
            className="h-8 w-8"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close"
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
