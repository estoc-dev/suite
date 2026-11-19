import { decodeObject, encodeObject, LinkValue, linkOf } from "@estoc/object";
import { array, link, schema, string } from "@estoc/schema";
import { assert, describe, expect, it } from "vitest";
import { decodeBundle, encodeBundle } from "../src/index.ts";

const note = schema("Note", { text: string() });
const card = schema("Card", { name: string() });
const links = schema("Links", { links: array(link()) });
const hello = encodeObject(note, { text: "hello" });
const alice = encodeObject(card, { name: "Alice" });
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = encodeObject(links, {
  links: [new LinkValue(alice.link), new LinkValue(hello.link), new LinkValue(linkOf(image))],
});

describe("a bundle", () => {
  it("gives blobs of several kinds back by their links together", () => {
    const bundle = decodeBundle(encodeBundle(root.link, [root.bytes, alice.bytes, hello.bytes, image]));
    expect([alice.link, hello.link, linkOf(image)].map((link) => bundle.get(link))).toEqual([
      alice.bytes,
      hello.bytes,
      image,
    ]);
  });

  it("gives an object back as bytes that do not read as an object of another schema", () => {
    const bundle = decodeBundle(encodeBundle(root.link, [root.bytes, hello.bytes]));
    const bytes = bundle.get(hello.link);
    assert.exists(bytes);
    // @ts-expect-error: refused at compile time too
    expect(() => decodeObject(bytes, links)).toThrow();
  });
});
