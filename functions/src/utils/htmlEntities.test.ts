import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "./htmlEntities";

describe("decodeHtmlEntities", () => {
  it("decodes a named ampersand entity (#233)", () => {
    expect(decodeHtmlEntities("AL&amp;FA Taxi KG")).toBe("AL&FA Taxi KG");
  });

  it("decodes angle brackets and quotes", () => {
    expect(decodeHtmlEntities("&lt;Best&gt; &quot;Company&quot;&apos;s")).toBe(
      "<Best> \"Company\"'s"
    );
  });

  it("decodes decimal and hex numeric references", () => {
    expect(decodeHtmlEntities("Tom &#38; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("Tom &#x26; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("Tom &#X26; Jerry")).toBe("Tom & Jerry");
  });

  it("leaves a name with no entity byte-identical, including a bare ampersand", () => {
    expect(decodeHtmlEntities("Q & A Solutions")).toBe("Q & A Solutions");
    expect(decodeHtmlEntities("AT&T")).toBe("AT&T");
    expect(decodeHtmlEntities("Muster GmbH")).toBe("Muster GmbH");
  });

  it("decodes double-encoded input exactly once instead of unwinding it", () => {
    // "AL&FA" encoded twice: "&" -> "&amp;" -> "&amp;amp;"
    expect(decodeHtmlEntities("AL&amp;amp;FA Taxi KG")).toBe("AL&amp;FA Taxi KG");
  });

  it("passes through malformed or unknown references unchanged", () => {
    expect(decodeHtmlEntities("&notarealentity; &amp")).toBe("&notarealentity; &amp");
  });

  it("returns null for null, undefined and empty string", () => {
    expect(decodeHtmlEntities(null)).toBeNull();
    expect(decodeHtmlEntities(undefined)).toBeNull();
    expect(decodeHtmlEntities("")).toBeNull();
  });
});
