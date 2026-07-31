/**
 * Jest setup file - Mock Chrome Extension APIs
 */

// Mock chrome.runtime
const mockRuntime = {
  sendMessage: jest.fn(),
  onMessage: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
  getURL: jest.fn((path) => `chrome-extension://test-extension-id/${path}`),
  lastError: null,
};

// Mock chrome.tabs
const mockTabs = {
  create: jest.fn(),
  remove: jest.fn(),
  update: jest.fn(),
  sendMessage: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  onUpdated: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
};

// Mock chrome.downloads
const mockDownloads = {
  download: jest.fn(),
  cancel: jest.fn(),
  erase: jest.fn(),
  onCreated: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
};

// Mock chrome.storage
const mockStorage = {
  local: {
    get: jest.fn((keys, callback) => {
      if (callback) callback({});
      return Promise.resolve({});
    }),
    set: jest.fn((items, callback) => {
      if (callback) callback();
      return Promise.resolve();
    }),
  },
};

// Mock chrome.notifications
const mockNotifications = {
  create: jest.fn((id, options, callback) => {
    if (callback) callback(id);
  }),
  clear: jest.fn((id, callback) => {
    if (callback) callback(true);
  }),
  update: jest.fn(),
  onButtonClicked: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
  onClosed: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
};

// Mock chrome.webNavigation
const mockWebNavigation = {
  onCreatedNavigationTarget: {
    addListener: jest.fn(),
  },
  onBeforeNavigate: {
    addListener: jest.fn(),
  },
  onCommitted: {
    addListener: jest.fn(),
  },
};

// Mock chrome.webRequest
const mockWebRequest = {
  onHeadersReceived: {
    addListener: jest.fn(),
  },
  onBeforeRequest: {
    addListener: jest.fn(),
  },
};

// Mock chrome.windows
const mockWindows = {
  update: jest.fn(),
  get: jest.fn(),
};

// Mock chrome.scripting
const mockScripting = {
  executeScript: jest.fn(),
};

// Assign to global
global.chrome = {
  runtime: mockRuntime,
  tabs: mockTabs,
  downloads: mockDownloads,
  storage: mockStorage,
  notifications: mockNotifications,
  webNavigation: mockWebNavigation,
  webRequest: mockWebRequest,
  windows: mockWindows,
  scripting: mockScripting,
};

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  mockRuntime.lastError = null;
});

// Export mocks for direct access in tests
module.exports = {
  mockRuntime,
  mockTabs,
  mockDownloads,
  mockStorage,
  mockNotifications,
  mockWebNavigation,
  mockWebRequest,
  mockWindows,
  mockScripting,
};
