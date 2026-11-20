import {
  curveScheme,
  ed25519,
  ed25519Curve,
  eip191,
  isSameKey,
  loadIdentity,
  SoftwareSigner,
  solanaOffchain,
  verify,
} from "@estoc/identity";
import { MemoryBackend, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { Keyring } from "../src/index.ts";

const schemes = [ed25519, eip191, solanaOffchain];
const { keys, secretKeys } = loadIdentity(schemes);
const digest = new Uint8Array(32).fill(7);

function keyringOver(backend = new MemoryBackend(), store = new Store(new MemoryBackend())): Keyring {
  return new Keyring(store, backend, secretKeys);
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

  it("generates the secret key that the curve of the scheme draws", async () => {
    const secret = new Uint8Array(32).fill(3);
    const drawing = curveScheme(
      "ed25519-drawing",
      { ...ed25519Curve, randomSecretKey: () => secret.slice() },
      ed25519.message,
    );
    const { secretKeys: drawingSecretKeys } = loadIdentity([drawing]);
    const backend = new MemoryBackend();
    const key = await new Keyring(new Store(new MemoryBackend()), backend, drawingSecretKeys).generate(drawing);
    expect(isSameKey(key, SoftwareSigner.fromSecretKey(drawing, secret).key)).toBe(true);
    const signer = await new Keyring(new Store(new MemoryBackend()), backend, drawingSecretKeys).signerFor(key.link);
    assert.exists(signer);
    expect(verify(key, digest, await signer.sign(digest))).toBe(true);
  });

  it("gives no signer for a key it does not hold", async () => {
    const keyring = keyringOver();
    await keyring.generate(ed25519);
    const other = keys.encode(SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1)).key);
    expect(await keyring.signerFor(other.link)).toBeUndefined();
  });

  it("holds its keys in the backend it is given, so a keyring made again over it signs with each", async () => {
    const backend = new MemoryBackend();
    const keyring = keyringOver(backend);
    const held = [await keyring.generate(ed25519), await keyring.generate(ed25519)];
    const again = keyringOver(backend);
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
