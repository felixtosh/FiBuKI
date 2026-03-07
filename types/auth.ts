import { Timestamp } from "firebase/firestore";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  isAdmin: boolean;
  emailVerified: boolean;
}

export interface AllowedEmail {
  id: string;
  email: string; // lowercase
  addedBy: string; // admin userId who added
  addedAt: Timestamp;
  usedAt?: Timestamp; // when they registered
  registeredUserId?: string; // their uid after registration
}

export interface AccessRequest {
  id: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  provider: "google" | "github";
  requestedAt: Timestamp;
  status: "pending" | "approved" | "dismissed";
  resolvedAt?: Timestamp;
  resolvedBy?: string; // admin userId
}

export interface UserRecord {
  id: string; // Firebase Auth UID
  email: string;
  displayName?: string;
  isAdmin: boolean;
  createdAt: Timestamp;
  lastLoginAt?: Timestamp;
}
