"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { de } from "date-fns/locale";
import { History, MessageSquare, Trash2, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { ChatSession } from "@/types/chat";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { Timestamp } from "firebase/firestore";

interface ChatHistoryPanelProps {
  onSelectSession: (sessionId: string) => void;
  currentSessionId?: string | null;
}

export function ChatHistoryPanel({
  onSelectSession,
  currentSessionId,
}: ChatHistoryPanelProps) {
  const { sessions, isLoading, deleteSession } = useChatSessions();
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | null>(null);

  // Filter sessions by search query
  const filteredSessions = sessions.filter((session) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      session.title.toLowerCase().includes(query) ||
      session.lastMessagePreview?.toLowerCase().includes(query)
    );
  });

  // Format timestamp to relative time
  const formatTime = (timestamp: Timestamp | Date) => {
    const date = timestamp instanceof Timestamp ? timestamp.toDate() : timestamp;
    return formatDistanceToNow(date, { addSuffix: true, locale: de });
  };

  // Handle session selection
  const handleSelectSession = (sessionId: string) => {
    onSelectSession(sessionId);
  };

  // Handle delete confirmation
  const handleDeleteClick = (e: React.MouseEvent, session: ChatSession) => {
    e.stopPropagation();
    setSessionToDelete(session);
  };

  // Handle actual deletion
  const handleConfirmDelete = async () => {
    if (!sessionToDelete) return;

    setDeletingSessionId(sessionToDelete.id);
    try {
      await deleteSession(sessionToDelete.id);
    } catch (error) {
      console.error("Failed to delete session:", error);
    } finally {
      setDeletingSessionId(null);
      setSessionToDelete(null);
    }
  };

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b px-4 h-14">
          <History className="h-5 w-5" />
          <span className="font-semibold">Chat History</span>
        </div>

        {/* Search */}
        <div className="p-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {/* Sessions list */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground px-4">
              <MessageSquare className="mb-4 h-10 w-10 opacity-20" />
              {searchQuery ? (
                <p className="text-sm">No conversations found matching &ldquo;{searchQuery}&rdquo;</p>
              ) : (
                <p className="text-sm">No conversation history yet</p>
              )}
            </div>
          ) : (
            <div className="py-2">
              {filteredSessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
                  className={cn(
                    "group flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors",
                    currentSessionId === session.id && "bg-muted"
                  )}
                >
                  <MessageSquare className="h-4 w-4 mt-1 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate">
                        {session.title}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        onClick={(e) => handleDeleteClick(e, session)}
                        disabled={deletingSessionId === session.id}
                      >
                        {deletingSessionId === session.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                        )}
                      </Button>
                    </div>
                    {session.lastMessagePreview && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {session.lastMessagePreview}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">
                        {formatTime(session.updatedAt)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        · {session.messageCount} messages
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!sessionToDelete} onOpenChange={() => setSessionToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{sessionToDelete?.title}&rdquo; and all its messages.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
