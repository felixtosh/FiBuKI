"use client";

import { initializeApp, getApps } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { getAuth, connectAuthEmulator, setPersistence, browserLocalPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDhxXMbHgaD1z9n0bkuVaSRmmiCrbNL-l4",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "fibuki.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "taxstudio-f12fb.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "534848611676",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:534848611676:web:8a3d1ede57c65b7e884d99",
};

// Initialize Firebase (singleton pattern)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, "europe-west1");
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence);

// Emulator configuration
const EMULATOR_CONFIG = {
  auth: { host: "localhost", port: 9099 },
  firestore: { host: "localhost", port: 8080 },
  storage: { host: "localhost", port: 9199 },
  functions: { host: "localhost", port: 5001 },
};

let emulatorsConnected = false;
let emulatorCheckDone = false;

/**
 * Check if emulators are running by attempting to connect
 */
async function checkEmulatorsRunning(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  try {
    const response = await fetch(`http://${EMULATOR_CONFIG.firestore.host}:${EMULATOR_CONFIG.firestore.port}/`, {
      method: "GET",
      mode: "no-cors",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Connect to Firebase emulators in development mode
 */
export function connectEmulators() {
  if (emulatorsConnected) return;
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "development") return;

  try {
    connectAuthEmulator(auth, `http://${EMULATOR_CONFIG.auth.host}:${EMULATOR_CONFIG.auth.port}`);
    connectFirestoreEmulator(db, EMULATOR_CONFIG.firestore.host, EMULATOR_CONFIG.firestore.port);
    connectStorageEmulator(storage, EMULATOR_CONFIG.storage.host, EMULATOR_CONFIG.storage.port);
    connectFunctionsEmulator(functions, EMULATOR_CONFIG.functions.host, EMULATOR_CONFIG.functions.port);
    emulatorsConnected = true;
    console.log(
      "%c[Firebase] Connected to emulators (Auth:9099, Firestore:8080, Storage:9199, Functions:5001)",
      "color: #4CAF50; font-weight: bold"
    );
  } catch (e) {
    // Emulators already connected
  }
}

/**
 * Verify emulators are running and warn if not
 */
export async function verifyEmulatorConnection(): Promise<void> {
  if (emulatorCheckDone) return;
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "development") return;

  emulatorCheckDone = true;

  const isRunning = await checkEmulatorsRunning();

  if (!isRunning) {
    console.error(
      "%c[Firebase] EMULATORS NOT RUNNING!\n" +
      "You are in development mode but emulators are not detected.\n" +
      "Run: firebase emulators:start\n" +
      "Or set NEXT_PUBLIC_USE_EMULATORS=false to use production (not recommended)",
      "color: #f44336; font-weight: bold; font-size: 14px"
    );

    // Show alert in browser
    if (typeof window !== "undefined" && !sessionStorage.getItem("emulator-warning-shown")) {
      sessionStorage.setItem("emulator-warning-shown", "true");
      setTimeout(() => {
        alert(
          "Firebase Emulators Not Running!\n\n" +
          "Start emulators with:\n" +
          "firebase emulators:start"
        );
      }, 1000);
    }
  }
}

// Auto-connect to emulators in development (default behavior)
// IMPORTANT: Always use emulators in development to avoid production data issues
// To use production services in dev (NOT RECOMMENDED), set NEXT_PUBLIC_USE_EMULATORS=false
if (
  typeof window !== "undefined" &&
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_USE_EMULATORS !== "false"
) {
  connectEmulators();
  // Verify after a short delay to allow page to load
  setTimeout(() => verifyEmulatorConnection(), 2000);
}

export default app;
