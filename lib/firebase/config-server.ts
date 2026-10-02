import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getFirestore, Firestore } from "firebase/firestore";
import { getStorage as getFirebaseStorage, FirebaseStorage } from "firebase/storage";
import { validateEnv } from "../env-check";

validateEnv();

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDhxXMbHgaD1z9n0bkuVaSRmmiCrbNL-l4",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "taxstudio-f12fb.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "taxstudio-f12fb.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "534848611676",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:534848611676:web:8a3d1ede57c65b7e884d99",
};

const APP_NAME = "server";

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

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
 */
export function getServerDb(): Firestore {
  if (_db) return _db;

  const app = getServerApp();
  _db = getFirestore(app);

  return _db;
}

/**
 * Get the server-side Storage instance (singleton)
 */
export function getServerStorage(): FirebaseStorage {
  if (_storage) return _storage;

  const app = getServerApp();
  _storage = getFirebaseStorage(app);

  return _storage;
}
