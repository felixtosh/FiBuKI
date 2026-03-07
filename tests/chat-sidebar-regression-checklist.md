# Chat Sidebar Regression Checklist

## URL + Session Behavior
- Open `/transactions?id=<txId>`, click floating chat icon, verify URL appends `chat=1`.
- From history/events, open a specific chat, verify URL changes to `chat=<sessionId>`.
- Reload page with `chat=<sessionId>`, verify same session is loaded.
- Use browser back/forward across chat open/close and session switches, verify no snap-back to stale session IDs.

## Draft Mode
- Click top `+` and bottom `New Conversation`; verify empty draft opens immediately.
- Confirm no new `0 messages` entry appears in chat history.
- Send first message from draft; verify session is created then appears in history.

## Tab/Trigger Behavior
- Switch `Chat -> Notifications -> History -> Chat`; verify tabs remain clickable and responsive.
- Click chat icon from events list repeatedly; verify selected chat persists.
- Trigger wand flow and use "View in chat"; verify target session opens and URL matches it.

## No Duplicate/Appended History
- Open existing session from history, leave and re-open, verify no duplicate assistant messages are appended.
- Open worker session via wand, then switch to another session, verify stale load does not overwrite current view.
