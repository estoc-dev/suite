import { sameIdentity, SoftwareSigner, type Scheme } from "@estoc/identity";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  encodeSchema,
  identitySchema,
  json,
  linkOf,
  loadSignatures,
  type IdentityData,
  type Json,
  type JsonObject,
  type Schema,
} from "../src/index.ts";

const { identities } = await loadSignatures(defaultValidator);
const readIdentity = (bytes: Uint8Array) => identities.check(decodeObject(bytes, identities.schema));

const secretKey = new Uint8Array(32).fill(1);
const keyOf = (scheme: Scheme) => bytesToHex(SoftwareSigner.fromSecretKey(scheme, secretKey).identity.publicKey);
const ed25519Key = keyOf("ed25519");
const eip191Key = keyOf("eip191");
const written = (data: JsonObject) => json.encode(json.object(data, linkOf(json.encode(identitySchema))));

describe("an identity", () => {
  it.each(["ed25519", "eip191", "solana-offchain"] as const)("in %s reads back from its object as the same identity", (scheme) => {
    const identity = SoftwareSigner.fromSecretKey(scheme, secretKey).identity;
    const object = identities.encode(identity);
    // Without its label, as bytes read from a file or the network have none.
    const bytes: Uint8Array = object.bytes;
    const read = readIdentity(bytes);
    expect(sameIdentity(read, identity)).toBe(true);
    expect(read.link).toBe(object.link);
  });

  it("is not written with a key of another length than its scheme's", () => {
    expect(() => identities.encode({ scheme: "ed25519", publicKey: new Uint8Array(33) })).toThrow(/32 bytes/);
  });

  it("in a scheme this package does not know fits the identity schema, and does not read", async () => {
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const later = written({ publicKey: ed25519Key, scheme: "a-later-scheme" });
    expect(decodeObject(later, schema).data).toEqual({ publicKey: ed25519Key, scheme: "a-later-scheme" });
    expect(() => readIdentity(later)).toThrow(/unknown scheme/);
  });

  it.each<[string, JsonObject]>([
    ["a key of another scheme's length", { publicKey: eip191Key, scheme: "ed25519" }],
    ["a key shorter than its scheme's", { publicKey: ed25519Key, scheme: "eip191" }],
    ["the key in uppercase hex", { publicKey: ed25519Key.toUpperCase(), scheme: "ed25519" }],
    ["a scheme this package does not know", { publicKey: ed25519Key, scheme: "ed448" }],
    ["a scheme named after a property every object has", { publicKey: ed25519Key, scheme: "toString" }],
    ["a field besides publicKey and scheme", { publicKey: ed25519Key, scheme: "ed25519", role: "buyer" }],
    ["no key", { scheme: "ed25519" }],
    ["no scheme", { publicKey: ed25519Key }],
  ])("is refused with %s", (_, data) => {
    expect(() => readIdentity(written(data))).toThrow();
  });

  it("is refused written to another schema, though shaped the same", async () => {
    const lookalike: Schema<Json, IdentityData> = await encodeSchema({ ...identitySchema, title: "Key" }, defaultValidator);
    const bytes = json.encode(json.object({ publicKey: ed25519Key, scheme: "ed25519" }, lookalike.link));
    expect(() => readIdentity(bytes)).toThrow(/not to/);
    expect(() => identities.check(decodeObject(bytes, lookalike))).toThrow(/an identity is written to/);
  });
});
