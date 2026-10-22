import { createHash } from "node:crypto";
import { loadAuthorizations } from "@estoc/authorization";
import { SoftwareSigner } from "@estoc/identity";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  json,
  linkOf,
  linkSchema,
  loadSignatures,
  type Encoding,
  type Json,
  type JsonObject,
  type Link,
  type Schema,
  type SchemaValidator,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, writeBundle, type Bundle } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const utf8 = (text: string) => new TextEncoder().encode(text);
const hexOf = (bytes: Uint8Array) => linkOf(bytes).slice("sha256:".length);
const filesOf = (root: Uint8Array, ...blobs: Uint8Array[]) =>
  new Map([["index.json", root], ...blobs.map((blob) => [`blobs/sha256/${hexOf(blob)}`, blob] as const)]);
const rewritten = (bytes: Uint8Array, change: (data: JsonObject) => JsonObject) => {
  const { data, schema } = JSON.parse(new TextDecoder().decode(bytes)) as { data: JsonObject; schema: string };
  return json.encode({ data: change(data), schema });
};

// An encoding of another data type than `json`'s: lists of strings, written
// as JSON arrays. An object is its schema's link followed by its data, so its
// objects are not JSON's, and a schema says how many strings the data has.
type Strings = readonly string[];
const strings: Encoding<Strings> = {
  name: "strings",
  encode: (value) => json.encode(value),
  decode(bytes) {
    const value = json.decode(bytes);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("not a list of strings");
    return value as Strings;
  },
  object: (data, schema) => [schema, ...data],
  fields([schema, ...data]) {
    if (schema === undefined) throw new Error("an object is its schema's link followed by its data");
    return { data, schema: schema as Link<Schema<Strings>> };
  },
};
const count: SchemaValidator<number, Strings> = {
  language: {
    encoding: strings,
    encode: (count) => json.encode(count),
    decode(bytes) {
      const count = json.decode(bytes);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("not a count");
      return count;
    },
  },
  compile: async (count) => (data) => (data.length === count ? [] : [`${data.length} strings, not ${count}`]),
};

const note = await encodeSchema({ $schema: DRAFT, title: "Note", type: "string" }, defaultValidator);
const links = await encodeSchema(
  { $schema: DRAFT, title: "Links", type: "array", items: linkSchema },
  defaultValidator,
);
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hello = encodeObject(note, "hello");
const signature = await signatures.sign(hello, alice);
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = encodeObject(links, [signature.link, hello.link, linkOf(image)]);
const pair = await encodeSchema(2, count);
const greeting = encodeObject(pair, ["hello", "world"]);

describe("a bundle", () => {
  it("is written as index.json and one file per blob named by its link, and reads back the same", () => {
    const blobs = [signature.bytes, hello.bytes, image];
    const files = writeBundle(root, blobs);
    expect([...files.keys()].sort()).toEqual(["index.json", ...blobs.map((blob) => `blobs/sha256/${hexOf(blob)}`)].sort());
    const bundle = readBundle(files);
    expect(bundle.encoding).toBe(json);
    expect(bundle.root).toEqual(root.bytes);
    expect(bundle.link).toBe(root.link);
    for (const blob of [root.bytes, ...blobs]) expect(bundle.get(linkOf(blob))).toEqual(blob);
  });

  it("gives blobs of several kinds back by their links together", () => {
    const bundle = readBundle(writeBundle(root, [signature.bytes, hello.bytes]));
    expect([signature.link, hello.link].map((link) => bundle.get(link))).toEqual([signature.bytes, hello.bytes]);
  });

  it("gives a signature back as bytes that do not read as an object of another schema", () => {
    const bundle = readBundle(writeBundle(root, [signature.bytes]));
    // @ts-expect-error: refused at compile time too
    expect(() => decodeObject(bundle.get(linkOf(signature.bytes))!, note)).toThrow();
  });

  it.each<[string, () => Map<string, Uint8Array>]>([
    ["no index.json", () => new Map([...filesOf(root.bytes, hello.bytes)].filter(([path]) => path !== "index.json"))],
    ["an index.json formatted by hand", () => filesOf(utf8(JSON.stringify({ data: "hello", schema: note.link }, null, 2)))],
    ["an index.json that is a schema", () => filesOf(note.bytes)],
    ["an index.json that is not JSON", () => filesOf(image)],
    ["an index.json that is an object in another encoding", () => filesOf(greeting.bytes)],
    ["its root in an encoding it does not read", () => new Map([["index.strings", greeting.bytes]])],
    ["a blob that does not have the link its name says", () => new Map([...filesOf(root.bytes), [`blobs/sha256/${hexOf(hello.bytes)}`, image]])],
  ])("is refused with %s", (_, files) => {
    expect(() => readBundle(files())).toThrow();
  });

  it("names its root by the encoding the root is in, and reads it in that encoding among those it is given", () => {
    const files = writeBundle(greeting, [hello.bytes], strings);
    expect([...files.keys()].sort()).toEqual([`blobs/sha256/${hexOf(hello.bytes)}`, "index.strings"]);
    const bundle: Bundle<Json> | Bundle<Strings> = readBundle(files, [json, strings]);
    expect(bundle.encoding).toBe(strings);
    expect(bundle.link).toBe(greeting.link);
    expect(decodeObject(bundle.root, pair)).toEqual(greeting);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect(readBundle(writeBundle(hello, []), [json, strings]).encoding).toBe(json);
  });

  it("is refused with two roots, each in an encoding it reads", () => {
    const files = new Map([...filesOf(root.bytes), ["index.strings", greeting.bytes]]);
    expect(() => readBundle(files, [json, strings])).toThrow(/one root/);
  });

  it("is not written with a root that is not an object in the encoding it is said to be in", () => {
    expect(() => writeBundle(hello, [], strings)).toThrow(/not an object in strings/);
    expect(() => writeBundle(greeting, [])).toThrow(/not an object in json/);
  });

  it("is not written in an encoding whose name cannot name a root", () => {
    expect(() => writeBundle(hello, [], { ...json, name: "JSON" })).toThrow(/lowercase/);
  });

  it("reads with a signature as its root, which leads to the object it is over and to its identity", () => {
    const bundle = readBundle(writeBundle(signature, [hello.bytes, signature.identity.bytes]));
    expect(bundle.link).toBe(signature.link);
    const signed = signatures.decode(bundle.root, bundle);
    expect(signatures.decode(bundle.get(bundle.link)!, bundle)).toEqual(signed);
    expect(signed.identity).toEqual(identities.encode(alice.identity));
    expect(decodeObject(bundle.get(signed.object)!, note).data).toBe("hello");
  });

  it("takes as its root an object in the type a semantics read it into, and writes it as it was signed", async () => {
    const authorizations = await loadAuthorizations(defaultValidator);
    const agent = SoftwareSigner.fromSecretKey("eip191", new Uint8Array(32).fill(2));
    const grant = await authorizations.authorize(agent.identity, alice);
    const bundle = readBundle(writeBundle(grant.object, [grant.signature.bytes, grant.object.agent.bytes, grant.signature.identity.bytes]));
    expect(bundle.link).toBe(grant.object.link);
    expect(authorizations.readAuthorization(bundle.get(grant.signature.link)!, bundle)).toEqual(grant);
  });

  it("reads with a signature that does not verify or whose scheme is unknown, as bytes", () => {
    const changed = rewritten(signature.bytes, (fields) => {
      const hex = fields.signature as string;
      return { ...fields, signature: `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}` };
    });
    const later = rewritten(signature.identity.bytes, (fields) => ({ ...fields, scheme: "a-later-scheme" }));
    const unknown = rewritten(signature.bytes, (fields) => ({ ...fields, identity: linkOf(later) }));
    const identityBytes = new Map([signature.identity.bytes, later].map((bytes) => [linkOf(bytes), bytes]));
    for (const blob of [changed, unknown]) {
      expect(() => signatures.decode(blob, identityBytes)).toThrow();
      expect(readBundle(filesOf(root.bytes, blob)).get(linkOf(blob))).toEqual(blob);
    }
  });

  it.each<[string, Uint8Array]>([
    [".DS_Store", image],
    ["__MACOSX/._index.json", image],
    ["blobs/", new Uint8Array()],
    ["blobs/sha256/", new Uint8Array()],
    [`blobs/sha256/${hexOf(hello.bytes).toUpperCase()}`, hello.bytes],
    [`blobs/sha256/${hexOf(hello.bytes).slice(1)}`, hello.bytes],
    [`blobs/sha512/${createHash("sha512").update(hello.bytes).digest("hex")}`, hello.bytes],
  ])("reads with %s as no blob", (path, bytes) => {
    const bundle = readBundle(new Map([...filesOf(root.bytes), [path, bytes]]));
    expect(bundle.link).toBe(root.link);
    expect(bundle.get(linkOf(bytes))).toBeUndefined();
  });

  it("reads without blobs its root links to, which it does not get", () => {
    const bundle = readBundle(filesOf(root.bytes, signature.bytes));
    expect(bundle.get(signature.link)).toEqual(signature.bytes);
    expect(bundle.get(hello.link)).toBeUndefined();
    expect(bundle.get(linkOf(image))).toBeUndefined();
  });

  it("with only index.json is one object, and gets only that", () => {
    const bundle = readBundle(filesOf(hello.bytes));
    expect(bundle.link).toBe(hello.link);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect(bundle.get(signature.link)).toBeUndefined();
  });

  it("reads the same with its root under blobs/ as well", () => {
    const bundle = readBundle(filesOf(root.bytes, root.bytes, hello.bytes));
    expect(bundle.link).toBe(root.link);
    expect(bundle.get(root.link)).toEqual(root.bytes);
  });

  it.each<[string, (bytes: Uint8Array) => Uint8Array]>([
    ["arrays", (bytes) => bytes.slice()],
    ["Node Buffers", (bytes) => Buffer.from(bytes)],
  ])("keeps the bytes it checked when the given %s change afterwards", (_, given) => {
    const files = filesOf(given(root.bytes), given(signature.bytes), given(hello.bytes), given(signature.identity.bytes));
    const bundle = readBundle(files);
    for (const bytes of files.values()) bytes.fill(0x20);
    expect(bundle.root).toEqual(root.bytes);
    const signed = signatures.decode(bundle.get(signature.link)!, bundle);
    expect(bundle.get(signed.object)).toEqual(hello.bytes);
  });
});
