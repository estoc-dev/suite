import { decodeObject, encodeSchema, type Json, type JsonObject, json, linkOf, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  ed25519,
  eip191,
  type KeyData,
  keyInterface,
  loadIdentity,
  type Scheme,
  SoftwareSigner,
  sameKey,
  solanaOffchain,
} from "../src/index.ts";
import { schemes } from "./fixtures.ts";

const { keys } = await loadIdentity(defaultValidator);
const readKey = (bytes: Uint8Array) => keys.read(linkOf(bytes), new Map([[linkOf(bytes), bytes]]));

const secretKey = new Uint8Array(32).fill(1);
const publicKeyOf = (scheme: Scheme) => bytesToHex(SoftwareSigner.fromSecretKey(scheme, secretKey).key.publicKey);
const ed25519Key = publicKeyOf(ed25519);
const eip191Key = publicKeyOf(eip191);
const written = (scheme: Scheme, data: JsonObject) =>
  json.encode(json.object(data, linkOf(json.encode(scheme.keySchema))));

describe("a key", () => {
  it.each(schemes)("in $name reads back from its object as the same key", async (scheme) => {
    const key = SoftwareSigner.fromSecretKey(scheme, secretKey).key;
    const object = keys.encode(key);
    // Without its label, as bytes read from a file or the network have none.
    const bytes: Uint8Array = object.bytes;
    const read = await readKey(bytes);
    expect(sameKey(read, key)).toBe(true);
    expect(read.link).toBe(object.link);
  });

  it("is written to its scheme's schema, so one public key in two schemes is two objects", () => {
    const { publicKey } = SoftwareSigner.fromSecretKey(ed25519, secretKey).key;
    const plain = keys.encode({ scheme: ed25519, publicKey });
    const solana = keys.encode({ scheme: solanaOffchain, publicKey });
    expect(plain.data).toEqual(solana.data);
    expect(plain.schema.link).not.toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("is not written with a public key of another length than its scheme's", () => {
    expect(() => keys.encode({ scheme: ed25519, publicKey: new Uint8Array(33) })).toThrow(/does not fit/);
  });

  it("is not written in a scheme other than those the keys know, even a copy of one", () => {
    const { publicKey } = SoftwareSigner.fromSecretKey(ed25519, secretKey).key;
    expect(() => keys.encode({ scheme: { ...ed25519 }, publicKey })).toThrow(
      "the ed25519 scheme is not one written here",
    );
  });

  it.each<[string, Scheme, JsonObject]>([
    ["a public key of another scheme's length", ed25519, { publicKey: eip191Key }],
    ["a public key shorter than its scheme's", eip191, { publicKey: ed25519Key }],
    ["the public key in uppercase hex", ed25519, { publicKey: ed25519Key.toUpperCase() }],
    ["a field besides publicKey", ed25519, { publicKey: ed25519Key, role: "buyer" }],
    ["the scheme written as a field", ed25519, { publicKey: ed25519Key, scheme: "ed25519" }],
    ["no public key", ed25519, {}],
  ])("is refused with %s", async (_, scheme, data) => {
    await expect(readKey(written(scheme, data))).rejects.toThrow(/does not fit/);
  });

  it("is refused written to a schema that no scheme it knows writes to, though shaped the same", async () => {
    const lookalike: Schema<Json, KeyData> = await encodeSchema(
      { ...ed25519.keySchema, title: "Ed448 key" },
      defaultValidator,
    );
    const bytes = json.encode(json.object({ publicKey: ed25519Key }, lookalike.link));
    await expect(readKey(bytes)).rejects.toThrow(`${lookalike.link} is not a schema read here`);
    expect(() => keys.check(decodeObject(bytes, lookalike))).toThrow(`${lookalike.link} is not a schema read here`);
  });

  it.each(schemes)("in $name is written to a schema that names the Key interface", (scheme) => {
    expect(scheme.keySchema["x-implements"]).toEqual({ $link: keyInterface.link });
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const object = keys.encode(SoftwareSigner.fromSecretKey(ed25519, secretKey).key);
    const other = keys.encode(SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2)).key);
    await expect(keys.read(object.link, new Map([[object.link, other.bytes]]))).rejects.toThrow(/another blob/);
  });
});
