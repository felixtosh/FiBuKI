import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, Firestore } from "firebase/firestore";
import { getStorage as getFirebaseStorage, connectStorageEmulator, FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDhxXMbHgaD1z9n0bkuVaSRmmiCrbNL-l4",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "taxstudio-f12fb.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "taxstudio-f12fb.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "534848611676",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:534848611676:web:8a3d1ede57c65b7e884d99",
};

// Emulator configuration - centralized for consistency
const EMULATOR_CONFIG = {
  firestore: { host: "localhost", port: 8080 },
  storage: { host: "localhost", port: 9199 },
  functions: { host: "localhost", port: 5001 },
};

const APP_NAME = "server";

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;
let _emulatorConnected = false;
let _storageEmulatorConnected = false;

/**
 * Check if we should use emulators
 */
function shouldUseEmulators(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_USE_EMULATORS !== "false"
  );
}

/**
 * Log emulator connection status
 */
function logEmulatorStatus(service: string, connected: boolean): void {
  if (connected) {
    console.log(`\x1b[32m[Server] Connected to ${service} emulator\x1b[0m`);
  } else {
    console.warn(
      `\x1b[33m[Server] WARNING: ${service} emulator connection failed!\x1b[0m\n` +
      `Make sure emulators are running: firebase emulators:start`
    );
  }
}

/**
 * Get the server-side Firebase app (singleton)
 */
export function getServerApp(): FirebaseApp {
  if (_app) return _app;

  _app = getApps().find((a) => a.name === APP_NAME) || initializeApp(firebaseConfig, APP_NAME);
  return _app;
}

/**
 * Get the server-side Firestore instance (singleton)
 * IMPORTANT: Always connects to emulator in development mode
 */
export function getServerDb(): Firestore {
  if (_db) return _db;

  const app = getServerApp();
  _db = getFirestore(app);

  // Connect to emulator in development
  if (shouldUseEmulators() && !_emulatorConnected) {
    try {
      connectFirestoreEmulator(_db, EMULATOR_CONFIG.firestore.host, EMULATOR_CONFIG.firestore.port);
      _emulatorConnected = true;
      logEmulatorStatus("Firestore", true);
    } catch (e) {
      // Already connected or failed
      if (String(e).includes("already")) {
        _emulatorConnected = true;
      } else {
        logEmulatorStatus("Firestore", false);
      }
    }
  }

  return _db;
}

/**
 * Get the server-side Storage instance (singleton)
 * IMPORTANT: Always connects to emulator in development mode
 */
export function getServerStorage(): FirebaseStorage {
  if (_storage) return _storage;

  const app = getServerApp();
  _storage = getFirebaseStorage(app);

  // Connect to emulator in development
  if (shouldUseEmulators() && !_storageEmulatorConnected) {
    try {
      connectStorageEmulator(_storage, EMULATOR_CONFIG.storage.host, EMULATOR_CONFIG.storage.port);
      _storageEmulatorConnected = true;
      logEmulatorStatus("Storage", true);
    } catch (e) {
      // Already connected or failed
      if (String(e).includes("already")) {
        _storageEmulatorConnected = true;
      } else {
        logEmulatorStatus("Storage", false);
      }
    }
  }

  return _storage;
}

/**
 * Check if emulators are being used
 */
export function isUsingEmulators(): boolean {
  return shouldUseEmulators() && _emulatorConnected;
}

/**
 * Get emulator host for Storage URLs
 */
export function getStorageEmulatorHost(): string | null {
  if (shouldUseEmulators()) {
    return `${EMULATOR_CONFIG.storage.host}:${EMULATOR_CONFIG.storage.port}`;
  }
  return null;
}
