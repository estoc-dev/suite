import { type Link, LinkValue, linkOf, ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import { secretSchema } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  ed25519,
  eip191,
  isSameKey,
  loadIdentity,
  type Scheme,
  type SecretKeyObject,
  SoftwareSigner,
  verify,
} from "../src/index.ts";
import { byLink, closure, dataOf, schemes } from "./fixtures.ts";

const { keys, secretKeys } = loadIdentity(schemes);
const secret = new Uint8Array(32).fill(1);
const digest = new Uint8Array(32).fill(7);
const written = (schema: Link<unknown>, data: ValueMap) => objectFormat.encode(new ObjectValue(schema, data));
const heldSecret = written(secretSchema.link, { bytes: secret });
const secretBlobs = [heldSecret, ...secretSchema.blobs];
const closureBlobsOf = ({ secret, blobs }: SecretKeyObject) => [...blobs, secret.bytes, ...secret.schema.blobs];

describe("a Secret Key", () => {
  it.each(schemes)("in $name reads back from its blobs with a signer its key verifies", async (scheme) => {
    const secretKey = secretKeys.encode(scheme, secret);
    const read = await secretKeys.read(secretKey.link, byLink(closureBlobsOf(secretKey)));
    expect(dataOf(read)).toEqual({ key: new LinkValue(secretKey.key.link), secret: new LinkValue(linkOf(heldSecret)) });
    expect(read.secret.data.bytes).toEqual(secret);
    expect(read.key.link).toBe(keys.encode(SoftwareSigner.fromSecretKey(scheme, secret).key).link);
    expect(isSameKey(read.signer.key, read.key)).toBe(true);
    expect(verify(read.key, digest, await read.signer.sign(digest))).toBe(true);
  });

  it.each(schemes)("in $name carries its closure as its blobs and its Secret, and nothing else", (scheme) => {
    const secretKey = secretKeys.encode(scheme, secret);
    const blobsByLink = byLink(closureBlobsOf(secretKey));
    expect(closure(secretKey.link, blobsByLink)).toEqual(new Set(blobsByLink.keys()));
    expect(secretKey.blobs.map((bytes) => linkOf(bytes))).not.toContain(secretKey.secret.link);
  });

  it("is refused when its secret is not that of its key", async () => {
    const other = keys.encode(SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2)).key);
    const bytes = written(secretKeys.schema.link, {
      key: new LinkValue(other.link),
      secret: new LinkValue(linkOf(heldSecret)),
    });
    await expect(secretKeys.read(linkOf(bytes), byLink([bytes, ...secretBlobs, ...other.blobs]))).rejects.toThrow(
      /is not that of/,
    );
  });

  it("is refused when its key is in a scheme no curve signs in", async () => {
    const plain: Scheme = { name: "plain", publicKeyLength: 32, verify: () => false };
    const kit = loadIdentity([...schemes, plain]);
    const key = kit.keys.encode({ scheme: plain, publicKey: new Uint8Array(32).fill(3) });
    const bytes = written(kit.secretKeys.schema.link, {
      key: new LinkValue(key.link),
      secret: new LinkValue(linkOf(heldSecret)),
    });
    await expect(kit.secretKeys.read(linkOf(bytes), byLink([bytes, ...secretBlobs, ...key.blobs]))).rejects.toThrow(
      /not one a curve signs in/,
    );
  });

  it("is refused when its key is in a scheme the kit does not read, and not written in one", async () => {
    const kit = loadIdentity([ed25519]);
    const secretKey = secretKeys.encode(eip191, secret);
    await expect(kit.secretKeys.read(secretKey.link, byLink(closureBlobsOf(secretKey)))).rejects.toThrow(
      /not a schema read here/,
    );
    expect(() => kit.secretKeys.encode(eip191, secret)).toThrow(/not one written here/);
  });
});
