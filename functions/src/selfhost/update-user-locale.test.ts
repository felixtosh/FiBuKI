/**
 * #168: the UI language is a per-user preference, written through a callable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { updateUserLocaleCallable } from "../users/updateUserLocale";

const db = getFirestore();
const USER = "u1";

function call(data: unknown) {
  return updateUserLocaleCallable.run({ data, auth: { uid: USER } } as never);
}

async function prefs() {
  return (await db.collection("users").doc(USER).collection("settings").doc("preferences").get()).data();
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("updateUserLocale", () => {
  it("stores the chosen language on the user's preferences", async () => {
    await expect(call({ locale: "de" })).resolves.toEqual({ success: true, locale: "de" });
    expect((await prefs())?.locale).toBe("de");
  });

  it("records where the choice came from", async () => {
    await call({ locale: "en", source: "browser" });
    expect((await prefs())?.localeSource).toBe("browser");
    await call({ locale: "de" });
    expect((await prefs())?.localeSource).toBe("user");
  });

  it("refuses a language the UI does not have", async () => {
    await expect(call({ locale: "fr" })).rejects.toThrow(/locale/);
    expect(await prefs()).toBeUndefined();
  });
});
