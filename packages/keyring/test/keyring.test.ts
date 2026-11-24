import {
  curveScheme,
  ed25519,
  ed25519Curve,
  eip191,
  identityKit,
  isSameKey,
  loadIdentity,
  SoftwareSigner,
  solanaOffchain,
  verify,
} from "@estoc/identity";
import { type Link, readObject } from "@estoc/object";
import { MemoryBackend, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { Keyring } from "../src/index.ts";

const schemes = [ed25519, eip191, solanaOffchain];
const { keys, secretKeys } = identityKit;
const digest = new Uint8Array(32).fill(7);

function keyringOver(backend = new MemoryBackend(), kit = secretKeys): Keyring {
  return new Keyring(new Store(backend), kit);
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
    const key = await keyringOver(backend, drawingSecretKeys).generate(drawing);
    expect(isSameKey(key, SoftwareSigner.fromSecretKey(drawing, secret).key)).toBe(true);
    const signer = await keyringOver(backend, drawingSecretKeys).signerFor(key.link);
    assert.exists(signer);
    expect(verify(key, digest, await signer.sign(digest))).toBe(true);
  });

  it("generates no key in a scheme written by hand with the members of one a curve signs in", async () => {
    const handwrittenScheme = {
      name: "ed25519-by-hand",
      publicKeyLength: 32,
      curve: ed25519Curve,
      message: ed25519.message,
      verify: ed25519.verify,
    };
    const backend = new MemoryBackend();
    const keyring = keyringOver(backend, loadIdentity([handwrittenScheme]).secretKeys);
    // @ts-expect-error: refused at compile time too
    await expect(keyring.generate(handwrittenScheme)).rejects.toThrow(/not one a curve signs in/);
    const statements = [];
    for await (const statement of new Store(backend).records()) statements.push(statement);
    expect(statements).toEqual([]);
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

  it("records the Secret Key of each key it generates, and writes the Secret with it", async () => {
    const backend = new MemoryBackend();
    const store = new Store(backend);
    const key = await keyringOver(backend).generate(ed25519);
    const statements = [];
    for await (const statement of store.records()) statements.push(statement);
    expect(statements).toHaveLength(1);
    const { data } = await readObject(store, statements[0] as Link<unknown>, secretKeys.schema);
    expect(data.key.link).toBe(key.link);
    expect(await store.get(data.secret.link)).toBeDefined();
  });

  it("gives no signer for a Secret Key that only came to the store, with its Secret", async () => {
    const backend = new MemoryBackend();
    const { link, key, blobs } = secretKeys.encode(ed25519, new Uint8Array(32).fill(1));
    await new Store(backend).write({ roots: [link], blobs });
    expect(await keyringOver(backend).signerFor(key.link)).toBeUndefined();
  });
});
