import { encodeSchema, type JsonObject, json, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { identitySchema, keySchemas, loadIdentities, type Scheme, SoftwareSigner, sameKey } from "../src/index.ts";

const identities = await loadIdentities(defaultValidator);
const { keys } = identities;
const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

const key = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill)).key;
const written = (data: JsonObject) => json.encode(json.object(data, linkOf(json.encode(identitySchema))));
const readFrom = (bytes: Uint8Array, ...blobs: Uint8Array[]) =>
  identities.read(linkOf(bytes), byLink([bytes, ...blobs]));

describe("an identity", () => {
  it.each(["ed25519", "eip191", "solana-offchain"] as const)(
    "with a %s root reads back from its blobs with its root",
    async (scheme) => {
      const identity = identities.encode(key(scheme));
      const read = await identities.read(identity.link, byLink(identity.blobs));
      expect(read.link).toBe(identity.link);
      expect(read.root.link).toBe(identity.root.link);
      expect(sameKey(read.root, key(scheme))).toBe(true);
    },
  );

  it("names its root by the link of the root's object", () => {
    const identity = identities.encode(key("ed25519"));
    expect(identity.data).toEqual({ root: { $link: keys.encode(key("ed25519")).link } });
  });

  it("is another identity for the same public key in another scheme", () => {
    const { publicKey } = key("ed25519");
    const plain = identities.encode({ scheme: "ed25519", publicKey });
    const solana = identities.encode({ scheme: "solana-offchain", publicKey });
    expect(plain.schema.link).toBe(solana.schema.link);
    expect(plain.link).not.toBe(solana.link);
  });

  it("carries as its blobs its object, its root's, and the schemas they are written to", async () => {
    const identity = identities.encode(key("eip191"));
    const schema = await encodeSchema(identitySchema, defaultValidator);
    const keySchema = await encodeSchema(keySchemas.eip191, defaultValidator);
    expect(identity.blobs.map((bytes) => linkOf(bytes))).toEqual([
      identity.link,
      identity.root.link,
      schema.link,
      keySchema.link,
    ]);
  });

  it("is refused without the blob of its root", async () => {
    await expect(readFrom(identities.encode(key("ed25519")).bytes)).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its root is not a key", async () => {
    const other = identities.encode(key("ed25519"));
    await expect(readFrom(written({ root: { $link: other.link } }), other.bytes)).rejects.toThrow(
      /no scheme writes its keys to/,
    );
  });

  it.each<[string, (root: JsonObject) => JsonObject]>([
    ["a field besides root", (root) => ({ root, name: "alice" })],
    ["its root as a bare string", (root) => ({ root: root.$link as string })],
    ["no root", () => ({})],
  ])("is refused with %s", async (_, data) => {
    const root = keys.encode(key("ed25519"));
    await expect(readFrom(written(data({ $link: root.link })), root.bytes)).rejects.toThrow(/does not fit/);
  });

  it("is refused when the reader gives another blob for its link", async () => {
    const identity = identities.encode(key("ed25519"));
    const other = identities.encode(key("ed25519", 2));
    await expect(identities.read(identity.link, new Map([[identity.link, other.bytes]]))).rejects.toThrow(
      /another blob/,
    );
  });
});
