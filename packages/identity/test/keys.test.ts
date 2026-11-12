import { decodeObject, linkOf, objectFormat, type ValueMap } from "@estoc/object";
import { bytes, schema } from "@estoc/schema";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  isSameKey,
  loadIdentity,
  SoftwareSigner,
  solanaOffchain,
} from "../src/index.ts";
import { schemes } from "./fixtures.ts";

const { keys } = loadIdentity(schemes);
const readKey = (bytes: Uint8Array) => keys.read(linkOf(bytes), new Map([[linkOf(bytes), bytes]]));

const secretKey = new Uint8Array(32).fill(1);
const publicKeyOf = (scheme: CurveScheme) => SoftwareSigner.fromSecretKey(scheme, secretKey).key.publicKey;
const ed25519Key = publicKeyOf(ed25519);
const eip191Key = publicKeyOf(eip191);
const written = (scheme: CurveScheme, data: ValueMap) =>
  objectFormat.encode(
    objectFormat.object(data, keys.encode(SoftwareSigner.fromSecretKey(scheme, secretKey).key).schema.link),
  );

describe("a key", () => {
  it.each(schemes)("in $name reads back from its object as the same key", async (scheme) => {
    const key = SoftwareSigner.fromSecretKey(scheme, secretKey).key;
    const object = keys.encode(key);
    // Without its label, as bytes read from a file or the network have none.
    const bytes: Uint8Array = object.bytes;
    const read = await readKey(bytes);
    expect(isSameKey(read, key)).toBe(true);
    expect(read.link).toBe(object.link);
  });

  it("is written to the schema of its scheme, so one public key in two schemes is two objects", () => {
    const { publicKey } = SoftwareSigner.fromSecretKey(ed25519, secretKey).key;
    const plain = keys.encode({ scheme: ed25519, publicKey });
    const solana = keys.encode({ scheme: solanaOffchain, publicKey });
    expect(plain.data).toEqual(solana.data);
    expect(plain.schema.link).not.toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("is not written with a public key of another length than its scheme's", () => {
    expect(() => keys.encode({ scheme: ed25519, publicKey: new Uint8Array(33) })).toThrow(
      "a public key in ed25519 is 32 bytes, not 33",
    );
  });

  it("is not written in a scheme other than those the keys support, even a copy of one", () => {
    const { publicKey } = SoftwareSigner.fromSecretKey(ed25519, secretKey).key;
    expect(() => keys.encode({ scheme: { ...ed25519 }, publicKey })).toThrow(
      "the ed25519 scheme is not one written here",
    );
  });

  it.each<[string, CurveScheme, ValueMap, RegExp]>([
    ["a public key of another scheme's length", ed25519, { publicKey: eip191Key }, /is 32 bytes, not 33/],
    ["a public key shorter than its scheme's", eip191, { publicKey: ed25519Key }, /is 33 bytes, not 32/],
    ["the public key in hex, which is a string", ed25519, { publicKey: bytesToHex(ed25519Key) }, /does not fit/],
    ["a field besides publicKey", ed25519, { publicKey: ed25519Key, role: "buyer" }, /does not fit/],
    ["the scheme written as a field", ed25519, { publicKey: ed25519Key, scheme: "ed25519" }, /does not fit/],
    ["no public key", ed25519, {}, /does not fit/],
  ])("is refused with %s", async (_, scheme, data, reason) => {
    await expect(readKey(written(scheme, data))).rejects.toThrow(reason);
  });

  it("is refused written to the schema of a scheme it does not support, though shaped the same", async () => {
    const lookalike = schema("ed25519ctx", { publicKey: bytes() });
    const written = objectFormat.encode(objectFormat.object({ publicKey: ed25519Key }, lookalike.link));
    await expect(readKey(written)).rejects.toThrow(`${lookalike.link} is not a schema read here`);
    expect(() => keys.check(decodeObject(written, lookalike))).toThrow(`${lookalike.link} is not a schema read here`);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const object = keys.encode(SoftwareSigner.fromSecretKey(ed25519, secretKey).key);
    const other = keys.encode(SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2)).key);
    await expect(keys.read(object.link, new Map([[object.link, other.bytes]]))).rejects.toThrow(/another blob/);
  });
});

describe("the schema of a scheme", () => {
  it.each(schemes)("of $name has the scheme's name as its title, and takes a public key alone", (scheme) => {
    const { schema } = keys.encode(SoftwareSigner.fromSecretKey(scheme, secretKey).key);
    expect(objectFormat.fields(objectFormat.decode(schema.bytes)).data).toEqual({
      title: scheme.name,
      fields: { publicKey: { type: "bytes" } },
    });
  });
});
