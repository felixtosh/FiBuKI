import { z } from "zod";
import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  Timestamp,
  limit as firestoreLimit,
} from "firebase/firestore";
import { nanoid } from "nanoid";
import { OperationsContext } from "../types.js";
import { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const INBOUND_ADDRESSES_COLLECTION = "inboundEmailAddresses";
const INBOUND_LOGS_COLLECTION = "inboundEmailLogs";

/** Email domain for inbound addresses */
const INBOUND_EMAIL_DOMAIN = "fibuki.com";

/** Default daily email limit */
const DEFAULT_DAILY_LIMIT = 100;

// Input schemas
const listInboundAddressesSchema = z.object({});

const getInboundAddressSchema = z.object({
  addressId: z.string().describe("The inbound address ID"),
});

const createInboundAddressSchema = z.object({
  displayName: z.string().optional().describe("Optional display name"),
  allowedDomains: z.array(z.string()).optional().describe("Optional list of allowed sender domains"),
  dailyLimit: z.number().optional().describe("Daily email limit (default 100)"),
});

const getInboundLogsSchema = z.object({
  addressId: z.string().describe("The inbound address ID"),
  limit: z.number().optional().default(50).describe("Max results (default 50)"),
});

// Tool definitions
export const emailInboundToolDefinitions: Tool[] = [
  {
    name: "list_inbound_email_addresses",
    description: "List all inbound email addresses configured for receiving invoices via email forwarding",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_inbound_email_address",
    description: "Get details of a specific inbound email address including stats",
    inputSchema: {
      type: "object",
      properties: {
        addressId: { type: "string", description: "The inbound address ID" },
      },
      required: ["addressId"],
    },
  },
  {
    name: "create_inbound_email_address",
    description: "Create a new inbound email address for receiving invoices. Returns the generated email address.",
    inputSchema: {
      type: "object",
      properties: {
        displayName: { type: "string", description: "Optional display name" },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of allowed sender domains",
        },
        dailyLimit: { type: "number", description: "Daily email limit (default 100)" },
      },
    },
  },
  {
    name: "get_inbound_email_logs",
    description: "Get recent email logs for an inbound address - shows received emails and their processing status",
    inputSchema: {
      type: "object",
      properties: {
        addressId: { type: "string", description: "The inbound address ID" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["addressId"],
    },
  },
];

// Tool handlers
export async function registerEmailInboundTools(
  ctx: OperationsContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult | null> {
  switch (toolName) {
    case "list_inbound_email_addresses":
      return handleListInboundAddresses(ctx);
    case "get_inbound_email_address":
      return handleGetInboundAddress(ctx, args);
    case "create_inbound_email_address":
      return handleCreateInboundAddress(ctx, args);
    case "get_inbound_email_logs":
      return handleGetInboundLogs(ctx, args);
    default:
      return null;
  }
}

async function handleListInboundAddresses(ctx: OperationsContext): Promise<CallToolResult> {
  const q = query(
    collection(ctx.db, INBOUND_ADDRESSES_COLLECTION),
    where("userId", "==", ctx.userId),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  const addresses = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      email: data.email,
      displayName: data.displayName,
      isActive: data.isActive,
      emailsReceived: data.emailsReceived || 0,
      filesCreated: data.filesCreated || 0,
      dailyLimit: data.dailyLimit,
      todayCount: data.todayDate === new Date().toISOString().split("T")[0] ? data.todayCount : 0,
      lastEmailAt: data.lastEmailAt?.toDate()?.toISOString() || null,
      createdAt: data.createdAt?.toDate()?.toISOString() || null,
    };
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ addresses }, null, 2),
      },
    ],
  };
}

async function handleGetInboundAddress(
  ctx: OperationsContext,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const { addressId } = getInboundAddressSchema.parse(args);

  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return {
      content: [{ type: "text", text: "Error: Address not found" }],
      isError: true,
    };
  }

  const data = snapshot.data();
  if (data.userId !== ctx.userId) {
    return {
      content: [{ type: "text", text: "Error: Address not found" }],
      isError: true,
    };
  }

  const today = new Date().toISOString().split("T")[0];

  const address = {
    id: snapshot.id,
    email: data.email,
    emailPrefix: data.emailPrefix,
    displayName: data.displayName,
    isActive: data.isActive,
    emailsReceived: data.emailsReceived || 0,
    filesCreated: data.filesCreated || 0,
    dailyLimit: data.dailyLimit,
    todayCount: data.todayDate === today ? data.todayCount : 0,
    allowedDomains: data.allowedDomains || [],
    lastEmailAt: data.lastEmailAt?.toDate()?.toISOString() || null,
    createdAt: data.createdAt?.toDate()?.toISOString() || null,
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ address }, null, 2),
      },
    ],
  };
}

async function handleCreateInboundAddress(
  ctx: OperationsContext,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const { displayName, allowedDomains, dailyLimit } = createInboundAddressSchema.parse(args);

  // Generate unique email prefix
  const emailPrefix = nanoid(21);
  const email = `invoices-${emailPrefix}@${INBOUND_EMAIL_DOMAIN}`;

  const now = Timestamp.now();
  const newAddress = {
    userId: ctx.userId,
    email,
    emailPrefix,
    displayName: displayName || null,
    isActive: true,
    emailsReceived: 0,
    filesCreated: 0,
    allowedDomains: allowedDomains || null,
    dailyLimit: dailyLimit || DEFAULT_DAILY_LIMIT,
    todayCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const docRef = await addDoc(
    collection(ctx.db, INBOUND_ADDRESSES_COLLECTION),
    newAddress
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          id: docRef.id,
          email,
          message: `Created inbound email address: ${email}. Forward invoices to this address and they will be automatically processed.`,
        }, null, 2),
      },
    ],
  };
}

async function handleGetInboundLogs(
  ctx: OperationsContext,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const { addressId, limit } = getInboundLogsSchema.parse(args);

  // Verify address ownership
  const addressRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  const addressSnap = await getDoc(addressRef);

  if (!addressSnap.exists() || addressSnap.data().userId !== ctx.userId) {
    return {
      content: [{ type: "text", text: "Error: Address not found" }],
      isError: true,
    };
  }

  const q = query(
    collection(ctx.db, INBOUND_LOGS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("inboundAddressId", "==", addressId),
    orderBy("receivedAt", "desc"),
    firestoreLimit(limit)
  );

  const snapshot = await getDocs(q);
  const logs = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      messageId: data.messageId,
      from: data.from,
      fromName: data.fromName,
      subject: data.subject,
      status: data.status,
      filesCreated: data.filesCreated || [],
      bodyConvertedToFile: data.bodyConvertedToFile || null,
      attachmentsProcessed: data.attachmentsProcessed || 0,
      error: data.error,
      rejectionReason: data.rejectionReason,
      receivedAt: data.receivedAt?.toDate()?.toISOString() || null,
    };
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ logs }, null, 2),
      },
    ],
  };
}
