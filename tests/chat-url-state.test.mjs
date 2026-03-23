import test from "node:test";
import assert from "node:assert/strict";
import { parseChatUrlState, consumeChatUrlParam } from "../lib/chat/chat-url-state.js";

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

test("consumeChatUrlParam: no-op when window is undefined (SSR)", () => {
  // In Node.js there's no window, so consumeChatUrlParam should just return without throwing.
  assert.doesNotThrow(() => consumeChatUrlParam());
});
