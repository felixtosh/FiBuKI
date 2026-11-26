import type { Timestamp } from "firebase/firestore";

export interface Receipt {
  id: string;
  transactionId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storagePath: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  extractedText?: string;
  aiSuggestedDescription?: string;
  uploadedAt: Timestamp;
  userId: string;
  createdAt: Timestamp;
}

export interface ReceiptUpload {
  file: File;
  transactionId: string;
  onProgress?: (progress: number) => void;
}
