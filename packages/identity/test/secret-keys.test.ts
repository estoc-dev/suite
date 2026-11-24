import { type Link, LinkValue, linkOf, ObjectValue, objectFormat, type ValueMap } from "@estoc/object";
import { secretSchema } from "@estoc/schema";
import { p256 } from "@noble/curves/nist.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  type CurveScheme,
  ed25519,
  ed25519Curve,
  eip191,
  identityKit,
  isSameKey,
  loadIdentity,
  type Scheme,
  SoftwareSigner,
  verify,
} from "../src/index.ts";
import { byLink, closure, dataOf, schemes } from "./fixtures.ts";

const { keys, secretKeys } = identityKit;
const secret = new Uint8Array(32).fill(1);
const digest = new Uint8Array(32).fill(7);
const written = (schema: Link<unknown>, data: ValueMap) => objectFormat.encode(new ObjectValue(schema, data));
const heldSecret = written(secretSchema.link, { bytes: secret });
const secretBlobs = [heldSecret, ...secretSchema.blobs];

const plain: Scheme = { name: "plain", publicKeyLength: 32, verify: () => false };
// A scheme that only verifies, and keeps the curve it verifies with in a member named as that of a
// scheme a curve signs in.
const verifyingP256: Scheme & { readonly curve: typeof p256 } = {
  name: "p256-der",
  publicKeyLength: 33,
  curve: p256,
  verify: (signature, text, publicKey) =>
    p256.verify(signature, utf8ToBytes(text), publicKey, { format: "der", lowS: true }),
};
const writtenByHand = {
  name: "ed25519-by-hand",
  publicKeyLength: 32,
  curve: ed25519Curve,
  message: ed25519.message,
  verify: ed25519.verify,
};

describe("a Secret Key", () => {
  it.each(schemes)("in $name reads back from its blobs with a signer its key verifies", async (scheme) => {
    const secretKey = secretKeys.encode(scheme, secret);
    const read = await secretKeys.read(secretKey.link, byLink(secretKey.blobs));
    expect(dataOf(read)).toEqual({ key: new LinkValue(secretKey.key.link), secret: new LinkValue(linkOf(heldSecret)) });
    expect(read.key.link).toBe(keys.encode(SoftwareSigner.fromSecretKey(scheme, secret).key).link);
    expect(isSameKey(read.signer.key, read.key)).toBe(true);
    expect(verify(read.key, digest, await read.signer.sign(digest))).toBe(true);
  });

  it.each(schemes)("in $name carries its closure as its blobs, its Secret as well, and nothing else", (scheme) => {
    const secretKey = secretKeys.encode(scheme, secret);
    const blobsByLink = byLink(secretKey.blobs);
    expect(closure(secretKey.link, blobsByLink)).toEqual(new Set(blobsByLink.keys()));
    expect(blobsByLink.get(linkOf(heldSecret))).toEqual(heldSecret);
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

  it.each([plain, verifyingP256, writtenByHand])(
    "is refused when its key is in $name, which no curve signs in",
    async (scheme) => {
      const kit = loadIdentity([...schemes, scheme]);
      const key = kit.keys.encode({ scheme, publicKey: new Uint8Array(scheme.publicKeyLength).fill(3) });
      const bytes = written(kit.secretKeys.schema.link, {
        key: new LinkValue(key.link),
        secret: new LinkValue(linkOf(heldSecret)),
      });
      await expect(kit.secretKeys.read(linkOf(bytes), byLink([bytes, ...secretBlobs, ...key.blobs]))).rejects.toThrow(
        /not one a curve signs in/,
      );
    },
  );

  it("is refused when its key is in a scheme the kit does not read, and not written in one", async () => {
    const kit = loadIdentity([ed25519]);
    const secretKey = secretKeys.encode(eip191, secret);
    await expect(kit.secretKeys.read(secretKey.link, byLink(secretKey.blobs))).rejects.toThrow(
      /not a schema read here/,
    );
    expect(() => kit.secretKeys.encode(eip191, secret)).toThrow(/not one written here/);
  });
});

describe("the scheme Secret Keys give by a name", () => {
  it.each(schemes)("is $name for its name", (scheme) => {
    expect(secretKeys.schemeNamed(scheme.name)).toBe(scheme);
  });

  it.each([plain, verifyingP256])("is none for $name, which no curve signs in", (scheme) => {
    const kit = loadIdentity([...schemes, scheme]);
    expect(kit.keys.schemeNamed(scheme.name)).toBe(scheme);
    expect(kit.secretKeys.schemeNamed(scheme.name)).toBeUndefined();
  });

  it("is none for a scheme written by hand with the members of one a curve signs in", () => {
    // @ts-expect-error: refused at compile time too
    const scheme: CurveScheme = writtenByHand;
    expect(loadIdentity([scheme]).secretKeys.schemeNamed(scheme.name)).toBeUndefined();
  });

  it("is none for a name no scheme has", () => {
    expect(secretKeys.schemeNamed("ed448")).toBeUndefined();
  });
});
