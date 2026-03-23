import type { ChatTab } from "@/types/chat";

const SIDEBAR_OPEN_KEY = "chatSidebarOpen";
const ACTIVE_TAB_KEY = "chatActiveTab";

const VALID_TABS: ReadonlySet<string> = new Set<ChatTab>(["chat", "notifications", "history"]);

export function readPersistedChatState(): {
  isSidebarOpen: boolean;
  activeTab: ChatTab;
} {
  try {
    const open = localStorage.getItem(SIDEBAR_OPEN_KEY);
    const tab = localStorage.getItem(ACTIVE_TAB_KEY);
    return {
      isSidebarOpen: open === "1",
      activeTab: tab && VALID_TABS.has(tab) ? (tab as ChatTab) : "notifications",
    };
  } catch {
    // SSR or localStorage unavailable
    return { isSidebarOpen: false, activeTab: "notifications" };
  }
}

export function persistSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

export function persistActiveTab(tab: ChatTab): void {
  try {
    localStorage.setItem(ACTIVE_TAB_KEY, tab);
  } catch {
    // ignore
  }
}
