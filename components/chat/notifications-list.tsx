"use client";

import { Bell, MessageSquare } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { AutoActionNotification } from "@/types/notification";
import { NotificationCard } from "./notification-card";

interface NotificationsListProps {
  notifications: AutoActionNotification[];
  onStartNewConversation: () => void;
}

export function NotificationsList({
  notifications,
  onStartNewConversation,
}: NotificationsListProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Notifications list */}
      <ScrollArea className="flex-1 px-4">
        <div className="space-y-1.5 py-2">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Bell className="mb-4 h-12 w-12 opacity-20" />
              <p className="text-sm">No notifications yet.</p>
              <p className="mt-2 text-xs">
                Auto-actions like imports and partner matching will appear here.
              </p>
            </div>
          ) : (
            notifications.map((notification) => (
              <NotificationCard
                key={notification.id}
                notification={notification}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Start conversation button (replaces input) */}
      <div className="border-t p-4">
        <Button className="w-full" size="lg" onClick={onStartNewConversation}>
          <MessageSquare className="mr-2 h-5 w-5" />
          New Conversation
        </Button>
      </div>
    </div>
  );
}
