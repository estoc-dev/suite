import { ed25519, eip191, isSameKey, loadIdentity, SoftwareSigner, solanaOffchain, verify } from "@estoc/identity";
import type { Link } from "@estoc/object";
import { MemoryBackend, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { Keyring } from "../src/index.ts";

const schemes = [ed25519, eip191, solanaOffchain];
const { keys, secretKeys } = loadIdentity(schemes);
const digest = new Uint8Array(32).fill(7);

function keyringOver(backend = new MemoryBackend(), store = new Store(new MemoryBackend())): Keyring {
  return new Keyring(store, backend, secretKeys);
}

async function linksOf(keys: AsyncIterable<Link<unknown>>): Promise<Link<unknown>[]> {
  const links = [];
  for await (const link of keys) links.push(link);
  return links;
}

describe("a keyring", () => {
  it.each(schemes)("gives a signer for a key in $name it generates, which the key verifies", async (scheme) => {
    const keyring = keyringOver();
    const key = await keyring.generate(scheme);
    const signer = await keyring.signerFor(key.link);
    assert.exists(signer);
    expect(isSameKey(signer.key, key)).toBe(true);
    expect(verify(key, digest, await signer.sign(digest))).toBe(true);
  });

  it("gives no signer for a key it does not hold", async () => {
    const keyring = keyringOver();
    await keyring.generate(ed25519);
    const other = keys.encode(SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1)).key);
    expect(await keyring.signerFor(other.link)).toBeUndefined();
  });

  it("lists each key it generates", async () => {
    const keyring = keyringOver();
    const first = await keyring.generate(ed25519);
    const second = await keyring.generate(ed25519);
    expect(first.link).not.toBe(second.link);
    expect(new Set(await linksOf(keyring.keys()))).toEqual(new Set([first.link, second.link]));
  });

  it("holds its keys in the backend it is given, so a keyring made again over it signs with each", async () => {
    const backend = new MemoryBackend();
    const keyring = keyringOver(backend);
    const held = [await keyring.generate(ed25519), await keyring.generate(ed25519)];
    const again = keyringOver(backend);
    expect(new Set(await linksOf(again.keys()))).toEqual(new Set(held.map(({ link }) => link)));
    for (const key of held) {
      const signer = await again.signerFor(key.link);
      assert.exists(signer);
      expect(verify(key, digest, await signer.sign(digest))).toBe(true);
    }
  });

  it("writes nothing to the store beside it", async () => {
    const storeBackend = new MemoryBackend();
    await keyringOver(new MemoryBackend(), new Store(storeBackend)).generate(ed25519);
    const blobs = [];
    for await (const blob of storeBackend.blobs()) blobs.push(blob);
    expect(blobs).toEqual([]);
  });
});
