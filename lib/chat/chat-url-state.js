const CHAT_PARAM_KEY = "chat";
const CHAT_OPEN_FLAG = "1";

/**
 * @param {{ get: (name: string) => string | null }} params
 * @returns {{ hasChatParam: boolean; isSidebarOpen: boolean; sessionId: string | null }}
 */
function parseChatUrlState(params) {
  const chatParam = params.get(CHAT_PARAM_KEY);
  if (!chatParam) {
    return {
      hasChatParam: false,
      isSidebarOpen: false,
      sessionId: null,
    };
  }

  return {
    hasChatParam: true,
    isSidebarOpen: true,
    sessionId: chatParam !== CHAT_OPEN_FLAG ? chatParam : null,
  };
}

/**
 * Strip the `?chat=` param from the URL without triggering a Next.js re-render.
 * Uses `window.history.replaceState` so no router involvement.
 */
function consumeChatUrlParam() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(CHAT_PARAM_KEY)) return;
  url.searchParams.delete(CHAT_PARAM_KEY);
  window.history.replaceState(window.history.state, "", url.toString());
}

module.exports = {
  parseChatUrlState,
  consumeChatUrlParam,
};
