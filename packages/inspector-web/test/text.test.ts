import { describe, expect, it } from "vitest";
import { hexOf, messageOf, sizeOf, typeNameOf } from "../src/text.ts";

describe("the name of a type", () => {
  it("is the type as the schema writes it", () => {
    expect(typeNameOf({ type: "link" })).toBe("link");
  });

  it("says what an array holds, through arrays of arrays", () => {
    expect(typeNameOf({ type: "array", items: { type: "array", items: { type: "string" } } })).toBe(
      "array of array of string",
    );
  });
});

describe("the hex of bytes", () => {
  it("is two lowercase digits a byte", () => {
    expect(hexOf(Uint8Array.of(0, 10, 255))).toBe("000aff");
  });
});

describe("the size of bytes", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [1234, "1,234 bytes"],
  ])("of length %i is %s", (length, size) => {
    expect(sizeOf(new Uint8Array(length))).toBe(size);
  });
});

describe("the message of what was thrown", () => {
  it("is that of an error, and the text of anything else", () => {
    expect(messageOf(new Error("not a schema"))).toBe("not a schema");
    expect(messageOf("not a schema")).toBe("not a schema");
  });
});
