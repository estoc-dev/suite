import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type Message } from "../src/index.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("a message", () => {
  it.each<[string, Message]>([
    ["an entry alone", { entry: utf8("entry"), blobs: [] }],
    ["empty blobs", { entry: new Uint8Array(), blobs: [new Uint8Array()] }],
    ["every byte value", { entry: Uint8Array.from({ length: 256 }, (_, i) => i), blobs: [new Uint8Array([0, 255])] }],
    ["one blob twice, out of order", { entry: utf8("e"), blobs: [utf8("b"), utf8("a"), utf8("b")] }],
  ])("holding %s reads back as it was written", (_, message) => {
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it.each([
    ["with whitespace", '{"blobs": [],"entry":"ZQ"}'],
    ["with its fields out of order", '{"entry":"ZQ","blobs":[]}'],
    ["without blobs", '{"entry":"ZQ"}'],
    ["without an entry", '{"blobs":[]}'],
    ["naming a sender", '{"blobs":[],"entry":"ZQ","from":"alice"}'],
    ["that is an array", '[[],"ZQ"]'],
    ["whose entry is not a string", '{"blobs":[],"entry":[101]}'],
    ["whose blobs are not an array", '{"blobs":"ZQ","entry":"ZQ"}'],
    ["holding a blob that is not a string", '{"blobs":[null],"entry":"ZQ"}'],
    ["padded with =", '{"blobs":[],"entry":"ZQ=="}'],
    ["in the alphabet with + and /", '{"blobs":[],"entry":"+/+/"}'],
    ["with bits set past its last byte", '{"blobs":[],"entry":"ZR"}'],
    ["one character short of a byte", '{"blobs":[],"entry":"Z"}'],
  ])("is refused %s", (_, text) => {
    expect(() => decodeMessage(utf8(text))).toThrow();
  });
});
