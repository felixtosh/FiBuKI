/**
 * The Mail Provider register (#102).
 *
 * Adding a Mail Provider is adding a file: the provider ships a descriptor
 * (id, label, credential fields, capability flags, factory) and registers it,
 * and the factory + the integrations UI read everything from the register
 * instead of from a hardcoded switch / Gmail-shaped form.
 *
 * Explicitly NOT a plugin runtime: providers are compiled-in TypeScript.
 *
 *   npx vitest run src/mail/__tests__/registry.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import {
  registerMailProvider,
  getMailProviderDescriptor,
  listMailProviderDescriptors,
  createMailProvider,
  MailProviderDescriptor,
} from "../registry";
// Importing the barrel is what registers the compiled-in providers.
import { GmailProvider, makeProvider } from "../index";

describe("mail provider register", () => {
  it("gmail is registered and describes itself", () => {
    const gmail = getMailProviderDescriptor("gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.id).toBe("gmail");
    expect(gmail!.label).toBe("Gmail");
    // The connect form renders from this, not from a hardcoded Gmail page.
    const keys = gmail!.credentialFields.map((f) => f.key);
    expect(keys).toContain("accessToken");
    const token = gmail!.credentialFields.find((f) => f.key === "accessToken")!;
    expect(token.secret).toBe(true);
    // Capability flags the Sync scheduler and UI may branch on.
    expect(gmail!.capabilities.serverSearch).toBe(true);
    expect(typeof gmail!.capabilities.incrementalSync).toBe("boolean");
  });

  it("the register lists what is registered", () => {
    const ids = listMailProviderDescriptors().map((d) => d.id);
    expect(ids).toContain("gmail");
  });

  it("creates a provider from its registered descriptor", () => {
    const p = createMailProvider("gmail", { accessToken: "tok" });
    expect(p).toBeInstanceOf(GmailProvider);
  });

  it("a missing declared credential is a descriptive refusal, not a crash later", () => {
    expect(() => createMailProvider("gmail", {})).toThrow(/access token/i);
  });

  it("an unregistered id names itself in the error", () => {
    expect(() => createMailProvider("carrier-pigeon", {})).toThrow(
      /Unknown mail provider/
    );
  });

  it("a second registration under a taken id is refused", () => {
    const dupe: MailProviderDescriptor = {
      id: "gmail",
      label: "Gmail again",
      credentialFields: [],
      capabilities: {
        serverSearch: false,
        filenameSearch: false,
        incrementalSync: false,
      },
      create: () => {
        throw new Error("never");
      },
    };
    expect(() => registerMailProvider(dupe)).toThrow(/already registered/i);
  });

  it("the legacy factory serves registered providers from the register", () => {
    const p = makeProvider("gmail", { accessToken: "tok" });
    expect(p).toBeInstanceOf(GmailProvider);
  });
});
