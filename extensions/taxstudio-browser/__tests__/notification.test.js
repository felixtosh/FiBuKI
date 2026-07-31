/**
 * Tests for Chrome notification functionality
 */

const { mockNotifications, mockTabs, mockWindows } = require("./setup");

// Simulated notification functions (would normally be imported from background.js)
// For testing, we recreate the logic here

function extractDomainForNotification(url) {
  try {
    var parsed = new URL(url);
    return parsed.hostname;
  } catch (err) {
    return "the website";
  }
}

function showLoginNotification(runId, url, runs) {
  if (!chrome.notifications) {
    console.warn("[FiBuKI] chrome.notifications API not available");
    return;
  }

  var domain = extractDomainForNotification(url);
  var notificationId = "ts_login_" + runId;

  chrome.notifications.create(
    notificationId,
    {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "FiBuKI: Login Required",
      message: "Please log in to " + domain + " to continue invoice collection.",
      buttons: [{ title: "Open Page" }, { title: "Dismiss" }],
      priority: 2,
      requireInteraction: true,
    },
    function (createdId) {
      // Callback
    }
  );
}

function handleNotificationButtonClick(notificationId, buttonIndex, runs) {
  if (!notificationId || notificationId.indexOf("ts_login_") !== 0) return;

  var runId = notificationId.replace("ts_login_", "");

  if (buttonIndex === 0) {
    // "Open Page" clicked - focus the tab
    if (runs[runId] && runs[runId].tabId) {
      chrome.tabs.update(runs[runId].tabId, { active: true });
      if (runs[runId].windowId) {
        chrome.windows.update(runs[runId].windowId, { focused: true });
      }
    }
  }

  // Clear the notification
  chrome.notifications.clear(notificationId);
}

describe("Chrome Notifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("extractDomainForNotification", () => {
    it("extracts domain from valid URL", () => {
      expect(
        extractDomainForNotification("https://admin.google.com/login")
      ).toBe("admin.google.com");
      expect(
        extractDomainForNotification("https://payments.google.com/billing")
      ).toBe("payments.google.com");
    });

    it('returns "the website" for invalid URLs', () => {
      expect(extractDomainForNotification("not-a-url")).toBe("the website");
      expect(extractDomainForNotification("")).toBe("the website");
    });
  });

  describe("showLoginNotification", () => {
    it("creates notification with correct parameters", () => {
      const runs = {
        "run-123": { tabId: 42, windowId: 1 },
      };

      showLoginNotification(
        "run-123",
        "https://admin.google.com/login",
        runs
      );

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        "ts_login_run-123",
        expect.objectContaining({
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "FiBuKI: Login Required",
          message: expect.stringContaining("admin.google.com"),
          requireInteraction: true,
          priority: 2,
        }),
        expect.any(Function)
      );
    });

    it("includes buttons for Open Page and Dismiss", () => {
      const runs = {};
      showLoginNotification("run-456", "https://example.com/login", runs);

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          buttons: [{ title: "Open Page" }, { title: "Dismiss" }],
        }),
        expect.any(Function)
      );
    });

    it("uses domain in notification message", () => {
      const runs = {};
      showLoginNotification(
        "run-789",
        "https://payments.google.com/auth",
        runs
      );

      const call = chrome.notifications.create.mock.calls[0];
      const options = call[1];
      expect(options.message).toContain("payments.google.com");
    });
  });

  describe("handleNotificationButtonClick", () => {
    it("focuses tab on Open Page click (button 0)", () => {
      const runs = {
        "run-123": { tabId: 42, windowId: 1 },
      };

      handleNotificationButtonClick("ts_login_run-123", 0, runs);

      expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
      expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
      expect(chrome.notifications.clear).toHaveBeenCalledWith(
        "ts_login_run-123"
      );
    });

    it("clears notification on Dismiss click (button 1)", () => {
      const runs = {
        "run-123": { tabId: 42, windowId: 1 },
      };

      handleNotificationButtonClick("ts_login_run-123", 1, runs);

      // Should NOT focus tab
      expect(chrome.tabs.update).not.toHaveBeenCalled();
      // Should clear notification
      expect(chrome.notifications.clear).toHaveBeenCalledWith(
        "ts_login_run-123"
      );
    });

    it("ignores non-FiBuKI notifications", () => {
      const runs = {};

      handleNotificationButtonClick("other_notification", 0, runs);

      expect(chrome.tabs.update).not.toHaveBeenCalled();
      expect(chrome.notifications.clear).not.toHaveBeenCalled();
    });

    it("handles missing run gracefully", () => {
      const runs = {};

      // Should not throw
      handleNotificationButtonClick("ts_login_nonexistent", 0, runs);

      // Notification should still be cleared
      expect(chrome.notifications.clear).toHaveBeenCalledWith(
        "ts_login_nonexistent"
      );
    });
  });

  describe("notification ID format", () => {
    it("uses ts_login_ prefix for login notifications", () => {
      const runs = {};
      showLoginNotification("abc-123", "https://example.com", runs);

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        "ts_login_abc-123",
        expect.any(Object),
        expect.any(Function)
      );
    });

    it("extracts runId from notification ID", () => {
      const notificationId = "ts_login_my-run-id";
      const runId = notificationId.replace("ts_login_", "");
      expect(runId).toBe("my-run-id");
    });
  });
});
