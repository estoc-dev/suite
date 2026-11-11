import { linkOf } from "@estoc/object";
import { describe, expect, it } from "vitest";
import { type CurveScheme, ed25519, eip191, isSameKey, loadIdentity, SoftwareSigner } from "../src/index.ts";
import { byLink, closure, schemes } from "./fixtures.ts";

const { keys, secretKeys, walletKeys } = loadIdentity(schemes);
const key = (scheme: CurveScheme) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(1)).key;

describe("a Wallet Key", () => {
  it.each(schemes)("in $name reads back from its blobs with its key", async (scheme) => {
    const walletKey = walletKeys.encode(key(scheme));
    const read = await walletKeys.read(walletKey.link, byLink(walletKey.blobs));
    expect(read.data).toEqual({ key: { $link: keys.encode(key(scheme)).link } });
    expect(read.key.link).toBe(walletKey.key.link);
    expect(isSameKey(read.key, key(scheme))).toBe(true);
  });

  it.each(schemes)("in $name carries its closure as its blobs, and nothing else", (scheme) => {
    const { link, blobs } = walletKeys.encode(key(scheme));
    const blobsByLink = byLink(blobs);
    expect(closure(link, blobsByLink)).toEqual(new Set(blobsByLink.keys()));
  });

  it("is not read as a Secret Key", async () => {
    const walletKey = walletKeys.encode(key(ed25519));
    const bytes: Uint8Array = walletKey.bytes;
    await expect(secretKeys.read(linkOf(bytes), byLink(walletKey.blobs))).rejects.toThrow(/is written to/);
  });

  it("is refused when its key is in a scheme the kit does not read, and not written in one", async () => {
    const kit = loadIdentity([ed25519]);
    const walletKey = walletKeys.encode(key(eip191));
    await expect(kit.walletKeys.read(walletKey.link, byLink(walletKey.blobs))).rejects.toThrow(
      /not a schema read here/,
    );
    expect(() => kit.walletKeys.encode(key(eip191))).toThrow(/not one written here/);
  });
});
