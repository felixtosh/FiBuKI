import type { Timestamp } from "firebase/firestore";

export interface Category {
  id: string;
  name: string;
  nameDE: string;
  color: string;
  icon: string;
  taxCode?: string;
  isDeductible: boolean;
  parentId?: string;
  sortOrder: number;
  isActive: boolean;
  userId: string | null; // null = system default
  createdAt: Timestamp;
}
