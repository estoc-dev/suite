import { decodeObject, encodeSchema, type Json, type JsonObject, json, linkOf, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  type IdentityData,
  identitySchemas,
  loadIdentities,
  type Scheme,
  SoftwareSigner,
  sameIdentity,
} from "../src/index.ts";

const identities = await loadIdentities(defaultValidator);
const readIdentity = (bytes: Uint8Array) => identities.read(linkOf(bytes), new Map([[linkOf(bytes), bytes]]));

const secretKey = new Uint8Array(32).fill(1);
const keyOf = (scheme: Scheme) => bytesToHex(SoftwareSigner.fromSecretKey(scheme, secretKey).identity.publicKey);
const ed25519Key = keyOf("ed25519");
const eip191Key = keyOf("eip191");
const written = (scheme: Scheme, data: JsonObject) =>
  json.encode(json.object(data, linkOf(json.encode(identitySchemas[scheme]))));

describe("an identity", () => {
  it.each(["ed25519", "eip191", "solana-offchain"] as const)(
    "in %s reads back from its object as the same identity",
    async (scheme) => {
      const identity = SoftwareSigner.fromSecretKey(scheme, secretKey).identity;
      const object = identities.encode(identity);
      // Without its label, as bytes read from a file or the network have none.
      const bytes: Uint8Array = object.bytes;
      const read = await readIdentity(bytes);
      expect(sameIdentity(read, identity)).toBe(true);
      expect(read.link).toBe(object.link);
    },
  );

  it("is written to its scheme's schema, so one key in two schemes is two objects", () => {
    const { publicKey } = SoftwareSigner.fromSecretKey("ed25519", secretKey).identity;
    const plain = identities.encode({ scheme: "ed25519", publicKey });
    const solana = identities.encode({ scheme: "solana-offchain", publicKey });
    expect(plain.data).toEqual(solana.data);
    expect(plain.schema.link).not.toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("is not written with a key of another length than its scheme's", () => {
    expect(() => identities.encode({ scheme: "ed25519", publicKey: new Uint8Array(33) })).toThrow(/does not fit/);
  });

  it.each<[string, Scheme, JsonObject]>([
    ["a key of another scheme's length", "ed25519", { publicKey: eip191Key }],
    ["a key shorter than its scheme's", "eip191", { publicKey: ed25519Key }],
    ["the key in uppercase hex", "ed25519", { publicKey: ed25519Key.toUpperCase() }],
    ["a field besides publicKey", "ed25519", { publicKey: ed25519Key, role: "buyer" }],
    ["the scheme written as a field", "ed25519", { publicKey: ed25519Key, scheme: "ed25519" }],
    ["no key", "ed25519", {}],
  ])("is refused with %s", async (_, scheme, data) => {
    await expect(readIdentity(written(scheme, data))).rejects.toThrow(/does not fit/);
  });

  it("is refused written to a schema that no scheme it knows writes to, though shaped the same", async () => {
    const lookalike: Schema<Json, IdentityData> = await encodeSchema(
      { ...identitySchemas.ed25519, title: "Ed448 identity" },
      defaultValidator,
    );
    const bytes = json.encode(json.object({ publicKey: ed25519Key }, lookalike.link));
    await expect(readIdentity(bytes)).rejects.toThrow(/no scheme writes its identities to/);
    expect(() => identities.check(decodeObject(bytes, lookalike))).toThrow(/no scheme writes its identities to/);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const object = identities.encode(SoftwareSigner.fromSecretKey("ed25519", secretKey).identity);
    const other = identities.encode(SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(2)).identity);
    await expect(identities.read(object.link, new Map([[object.link, other.bytes]]))).rejects.toThrow(/another blob/);
  });
});
