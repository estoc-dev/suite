import { type Link, LinkValue, linkOf, objectFormat, type ValueMap } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { ed25519, eip191, isSameKey, loadIdentity, type Scheme, SoftwareSigner, verify } from "../src/index.ts";
import { byLink, closure, schemes } from "./fixtures.ts";

const { keys, secretKeys } = loadIdentity(schemes);
const secret = new Uint8Array(32).fill(1);
const digest = new Uint8Array(32).fill(7);
const written = (schema: Link<unknown>, data: ValueMap) => objectFormat.encode(objectFormat.object(data, schema));

describe("a Secret Key", () => {
  it.each(schemes)("in $name reads back from its blobs with a signer its key verifies", async (scheme) => {
    const secretKey = secretKeys.encode(scheme, secret);
    const read = await secretKeys.read(secretKey.link, byLink(secretKey.blobs));
    expect(read.data).toEqual({ key: new LinkValue(secretKey.key.link), secret });
    expect(read.key.link).toBe(keys.encode(SoftwareSigner.fromSecretKey(scheme, secret).key).link);
    expect(isSameKey(read.signer.key, read.key)).toBe(true);
    expect(verify(read.key, digest, await read.signer.sign(digest))).toBe(true);
  });

  it.each(schemes)("in $name carries its closure as its blobs, and nothing else", (scheme) => {
    const { link, blobs } = secretKeys.encode(scheme, secret);
    const blobsByLink = byLink(blobs);
    expect(closure(link, blobsByLink)).toEqual(new Set(blobsByLink.keys()));
  });

  it("is refused when its secret is not that of its key", async () => {
    const other = keys.encode(SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2)).key);
    const bytes = written(secretKeys.schema.link, { key: new LinkValue(other.link), secret });
    await expect(secretKeys.read(linkOf(bytes), byLink([bytes, other.bytes]))).rejects.toThrow(/is not that of/);
  });

  it("is refused when its key is in a scheme no curve signs in", async () => {
    const plain: Scheme = { name: "plain", publicKeyLength: 32, verify: () => false };
    const kit = loadIdentity([...schemes, plain]);
    const key = kit.keys.encode({ scheme: plain, publicKey: new Uint8Array(32).fill(3) });
    const bytes = written(kit.secretKeys.schema.link, { key: new LinkValue(key.link), secret });
    await expect(kit.secretKeys.read(linkOf(bytes), byLink([bytes, key.bytes]))).rejects.toThrow(
      /not one a curve signs in/,
    );
  });

  it("is refused when its key is in a scheme the kit does not read, and not written in one", async () => {
    const kit = loadIdentity([ed25519]);
    const secretKey = secretKeys.encode(eip191, secret);
    await expect(kit.secretKeys.read(secretKey.link, byLink(secretKey.blobs))).rejects.toThrow(
      /not a schema read here/,
    );
    expect(() => kit.secretKeys.encode(eip191, secret)).toThrow(/not one written here/);
  });
});
