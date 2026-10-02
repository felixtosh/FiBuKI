"use client";

import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";

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

export default app;
