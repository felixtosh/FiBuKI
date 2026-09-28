/**
 * #266: VIES answers in XML, so a registered name with an "&" arrives as
 * "&amp;". The response is read with a regex, not an XML parser, and the
 * name was then title-cased into "Al&Amp;Fa Taxi Kg", which became both the
 * new Partner's name and the Global Partner's. The reference must be decoded
 * before the name is normalised.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({}),
  FieldValue: {},
  Timestamp: {},
}));

const { parseViesResponse } = await import("../lookupCompany");

function viesXml(name: string, address = "HAUPTSTRASSE 1, 1010 WIEN"): string {
  return (
    `<env:Envelope><env:Body><ns2:checkVatResponse>` +
    `<ns2:countryCode>AT</ns2:countryCode><ns2:vatNumber>U12345678</ns2:vatNumber>` +
    `<ns2:requestDate>2026-09-27+02:00</ns2:requestDate><ns2:valid>true</ns2:valid>` +
    `<ns2:name>${name}</ns2:name><ns2:address>${address}</ns2:address>` +
    `</ns2:checkVatResponse></env:Body></env:Envelope>`
  );
}

describe("parseViesResponse", () => {
  it("decodes a character reference in the registered name", () => {
    const result = parseViesResponse(viesXml("AL&amp;FA TAXI KG"));
    expect(result).toMatchObject({ valid: true, name: "Al&Fa Taxi Kg" });
  });

  it("decodes numeric references too", () => {
    const result = parseViesResponse(viesXml("TOM &#38; JERRY GMBH"));
    expect(result).toMatchObject({ name: "Tom & Jerry Gmbh" });
  });

  it("leaves a name with no reference as it was", () => {
    const result = parseViesResponse(viesXml("MUSTER GMBH"));
    expect(result).toMatchObject({ name: "Muster Gmbh" });
  });
});
