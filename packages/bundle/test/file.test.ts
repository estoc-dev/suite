import { EstLink, est, itself, linkOf, schemaOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { decodeBundle, encodeBundle } from "../src/index.ts";

const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// The objects are made with the encoding itself, to a schema that is an object
// written to itself, so that the bytes written out below turn on est alone.
const anything = est.encode(est.object({ title: "Anything" }, itself));
const hello = est.encode(est.object({ text: "hello" }, linkOf(anything)));
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = {
  bytes: est.encode(est.object({ links: [new EstLink(linkOf(hello)), new EstLink(linkOf(image))] }, linkOf(anything))),
};
const rootLink = linkOf(root.bytes);
const text = new TextEncoder().encode('{"text":"hello"}');

// The files of the tests are written out by hand, in hex, so that they do not
// turn on the writer they test.
const rootHex = hexOf(root.bytes);
const helloHex = `5837${hexOf(hello)}`;
const imageHex = `48${hexOf(image)}`;
const rootAsBlobHex = `587d${rootHex}`;
const decodeHex = (hex: string) => decodeBundle(bytesOf(hex));

describe("the file of a bundle", () => {
  it("is the bytes of its root, then each blob as a byte string", () => {
    expect(hello).toHaveLength(0x37);
    expect(root.bytes).toHaveLength(0x7d);
    expect(hexOf(encodeBundle(root, [hello, image]))).toBe(`${rootHex}${helloHex}${imageHex}`);
  });

  it("reads back the same", () => {
    const bundle = decodeBundle(encodeBundle(root, [hello, image, anything]));
    expect(bundle.root).toEqual(root.bytes);
    expect(bundle.link).toBe(rootLink);
    expect(schemaOf(bundle.root, est)).toBe(linkOf(anything));
    for (const blob of [root.bytes, hello, image, anything]) expect(bundle.get(linkOf(blob))).toEqual(blob);
    expect([...bundle.blobs()]).toEqual([root.bytes, hello, image, anything]);
  });

  it("that carries no blob is the bytes of its root, with its link", () => {
    const file = encodeBundle(root, []);
    expect(file).toEqual(root.bytes);
    expect(linkOf(file)).toBe(decodeBundle(file).link);
    expect([...decodeBundle(file).blobs()]).toEqual([root.bytes]);
  });

  it.each<[number, string]>([
    [0, "40"],
    [23, "57"],
    [24, "5818"],
    [255, "58ff"],
    [256, "590100"],
    [65535, "59ffff"],
    [65536, "5a00010000"],
  ])("writes a blob of %i bytes under the shortest head, and reads it back", (length, head) => {
    const blob = new Uint8Array(length).fill(7);
    const file = encodeBundle(root, [blob]);
    expect(hexOf(file.subarray(0, root.bytes.length + head.length / 2))).toBe(`${rootHex}${head}`);
    expect(file).toHaveLength(root.bytes.length + head.length / 2 + length);
    expect(decodeBundle(file).get(linkOf(blob))).toEqual(blob);
  });

  it("is written with a blob given twice, or its root given as a blob, once", () => {
    expect(hexOf(encodeBundle(root, [hello, root.bytes, image, hello.slice()]))).toBe(
      `${rootHex}${helloHex}${imageHex}`,
    );
  });

  it("reads with its blobs in any order", () => {
    const bundle = decodeHex(`${rootHex}${imageHex}${helloHex}`);
    expect(bundle.link).toBe(rootLink);
    expect([...bundle.blobs()]).toEqual([root.bytes, image, hello]);
  });

  it("reads without blobs its root links to, which it does not get", () => {
    const bundle = decodeHex(`${rootHex}${helloHex}`);
    expect(bundle.get(linkOf(hello))).toEqual(hello);
    expect(bundle.get(linkOf(image))).toBeUndefined();
  });

  it("does not read the blobs it carries, so one that is no object of est is bytes as an image is", () => {
    const cut = hello.slice(0, -1);
    const bundle = decodeBundle(encodeBundle(root, [text, cut]));
    expect(bundle.get(linkOf(text))).toEqual(text);
    expect(bundle.get(linkOf(cut))).toEqual(cut);
  });

  it.each<[string, string, string | RegExp]>([
    ["no bytes", "", /is an object of est/],
    ["a root that is text", hexOf(text), /is an object of est/],
    ["a root that is a map under no tag", "a0", /is an object of est/],
    ["a root that is a byte string, as a blob is", helloHex, /is an object of est/],
    ["a root cut short", rootHex.slice(0, -2), /is an object of est/],
    ["a root with an array of indefinite length", `da6573743f9f${rootHex.slice(12)}ff`, /is an object of est/],
    ["a blob twice", `${rootHex}${helloHex}${imageHex}${helloHex}`, `holds the blob ${linkOf(hello)} twice`],
    ["its root again as a blob", `${rootHex}${rootAsBlobHex}`, `holds the blob ${rootLink} twice`],
    ["a blob whose length runs past the end of the file", `${rootHex}49${hexOf(image)}`, /not enough data/],
    ["a blob cut short in its head", `${rootHex}58`, /not enough data/],
    ["a blob under a longer head", `${rootHex}5808${hexOf(image)}`, /more bytes than necessary/],
    ["a blob of indefinite length", `${rootHex}5f${imageHex}ff`, /indefinite length/],
    ["an object after the root that is not in a byte string", `${rootHex}${hexOf(hello)}`, /is a byte string/],
    ["a string after the root", `${rootHex}6568656c6c6f`, /is a byte string/],
    ["an integer after the root", `${rootHex}00`, /is a byte string/],
    ["an array of blobs after the root", `${rootHex}81${imageHex}`, /is a byte string/],
    ["a blob under a tag", `${rootHex}d82a${imageHex}`, /is a byte string/],
  ])("is refused with %s", (_, hex, reason) => {
    expect(() => decodeHex(hex)).toThrow(reason);
  });

  it.each<[string, Uint8Array]>([
    ["bytes that are no object", image],
    ["text", text],
    ["a file that carries a blob", bytesOf(`${rootHex}${imageHex}`)],
  ])("is not written with %s as its root", (_, bytes) => {
    expect(() => encodeBundle({ bytes }, [hello])).toThrow(/is an object of est/);
  });

  it.each<[string, (bytes: Uint8Array) => Uint8Array]>([
    ["array", (bytes) => bytes.slice()],
    ["Node Buffer", (bytes) => Buffer.from(bytes)],
    ["part of a Node Buffer", (bytes) => Buffer.concat([image, bytes, image]).subarray(8, 8 + bytes.length)],
  ])("keeps the bytes it checked when the given %s changes afterwards", (_, given) => {
    const file = given(encodeBundle(root, [hello, image]));
    const bundle = decodeBundle(file);
    file.fill(0x20);
    expect(bundle.root).toEqual(root.bytes);
    expect([...bundle.blobs()]).toEqual([root.bytes, hello, image]);
  });

  it("is written the same from Node Buffers", () => {
    const file = encodeBundle({ bytes: Buffer.from(root.bytes) }, [Buffer.from(hello), Buffer.from(image)]);
    expect(hexOf(file)).toBe(`${rootHex}${helloHex}${imageHex}`);
  });
});
