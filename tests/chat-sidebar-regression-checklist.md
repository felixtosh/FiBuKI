# Chat Sidebar Regression Checklist

## Persistence (localStorage)
- Open sidebar, reload page → sidebar is still open.
- Close sidebar, navigate to another page, reload → sidebar stays closed.
- Switch to History tab, reload → History tab is restored.
- Open sidebar on `/transactions`, navigate to `/files` (client nav) → sidebar stays open.

## Deep Links (`?chat=sessionId`)
- Navigate to `/transactions?chat=session_123` → sidebar opens, session loads, `?chat=` is stripped from URL.
- Navigate to `/transactions?chat=1` → sidebar opens on chat tab (draft), `?chat=` is stripped.
- After param is consumed, URL shows no `?chat=` param.

## Draft Mode
- Click top `+` and bottom `New Conversation`; verify empty draft opens immediately.
- Confirm no new `0 messages` entry appears in chat history.
- Send first message from draft; verify session is created then appears in history.

## Tab/Trigger Behavior
- Switch `Chat -> Notifications -> History -> Chat`; verify tabs remain clickable and responsive — no URL changes in the address bar.
- Click chat icon from events list repeatedly; verify selected chat persists.
- Trigger wand flow and use "View in chat"; verify target session opens.

## No Duplicate/Appended History
- Open existing session from history, leave and re-open, verify no duplicate assistant messages are appended.
- Open worker session via wand, then switch to another session, verify stale load does not overwrite current view.
