const CHAT_PARAM_KEY = "chat";
const CHAT_OPEN_FLAG = "1";
const LEGACY_CHAT_TAB_KEY = "chatTab";

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
 * @param {string} pathname
 * @param {{ toString: () => string }} currentParams
 * @param {{ isSidebarOpen: boolean; sessionId: string | null }} nextState
 * @returns {string | null}
 */
function buildNextChatUrl(pathname, currentParams, nextState) {
  const params = new URLSearchParams(currentParams.toString());

  if (nextState.isSidebarOpen) {
    params.set(CHAT_PARAM_KEY, nextState.sessionId || CHAT_OPEN_FLAG);
  } else {
    params.delete(CHAT_PARAM_KEY);
  }

  params.delete(LEGACY_CHAT_TAB_KEY);

  const nextParams = params.toString();
  const current = currentParams.toString();
  if (nextParams === current) return null;
  return nextParams ? `${pathname}?${nextParams}` : pathname;
}

module.exports = {
  parseChatUrlState,
  buildNextChatUrl,
};
