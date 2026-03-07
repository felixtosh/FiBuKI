import test from "node:test";
import assert from "node:assert/strict";
import { parseChatUrlState, buildNextChatUrl } from "../lib/chat/chat-url-state.js";

test("parseChatUrlState: missing chat param means closed", () => {
  const params = new URLSearchParams("id=abc");
  const result = parseChatUrlState(params);
  assert.deepEqual(result, {
    hasChatParam: false,
    isSidebarOpen: false,
    sessionId: null,
  });
});

test("parseChatUrlState: chat=1 means open without pinned session", () => {
  const params = new URLSearchParams("chat=1");
  const result = parseChatUrlState(params);
  assert.deepEqual(result, {
    hasChatParam: true,
    isSidebarOpen: true,
    sessionId: null,
  });
});

test("parseChatUrlState: chat=<id> means open with pinned session", () => {
  const params = new URLSearchParams("chat=session_123&id=tx_1");
  const result = parseChatUrlState(params);
  assert.deepEqual(result, {
    hasChatParam: true,
    isSidebarOpen: true,
    sessionId: "session_123",
  });
});

test("buildNextChatUrl: writes chat session id and preserves other params", () => {
  const current = new URLSearchParams("id=tx_1");
  const next = buildNextChatUrl("/transactions", current, {
    isSidebarOpen: true,
    sessionId: "session_123",
  });
  assert.equal(next, "/transactions?id=tx_1&chat=session_123");
});

test("buildNextChatUrl: writes chat=1 for draft/open state", () => {
  const current = new URLSearchParams("id=tx_1");
  const next = buildNextChatUrl("/transactions", current, {
    isSidebarOpen: true,
    sessionId: null,
  });
  assert.equal(next, "/transactions?id=tx_1&chat=1");
});

test("buildNextChatUrl: removes chat and legacy chatTab when closing", () => {
  const current = new URLSearchParams("id=tx_1&chat=session_123&chatTab=events");
  const next = buildNextChatUrl("/transactions", current, {
    isSidebarOpen: false,
    sessionId: null,
  });
  assert.equal(next, "/transactions?id=tx_1");
});

test("buildNextChatUrl: returns null when no effective change", () => {
  const current = new URLSearchParams("id=tx_1&chat=1");
  const next = buildNextChatUrl("/transactions", current, {
    isSidebarOpen: true,
    sessionId: null,
  });
  assert.equal(next, null);
});
