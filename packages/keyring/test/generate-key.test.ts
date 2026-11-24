import { ed25519, eip191, identityKit, solanaOffchain, verify } from "@estoc/identity";
import { type Link, readObject } from "@estoc/object";
import { MemoryBackend, perform, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { generateKey, Keyring } from "../src/index.ts";

const schemes = [ed25519, eip191, solanaOffchain];
const { keys, secretKeys } = identityKit;
const digest = new Uint8Array(32).fill(7);

const newStore = () => new Store(new MemoryBackend());

async function recordsOf(store: Store): Promise<Link<unknown>[]> {
  const statements: Link<unknown>[] = [];
  for await (const statement of store.records()) statements.push(statement);
  return statements;
}

describe("Generate Key", () => {
  it.each(schemes)(
    "gives a key in the scheme named $name, which a keyring over the store signs with",
    async (scheme) => {
      const store = newStore();
      const { result } = await perform(store, generateKey, { scheme: scheme.name });
      const key = await keys.read(result.data.key.link, store);
      expect(key.scheme).toBe(scheme);
      const signer = await new Keyring(store, secretKeys).signerFor(key.link);
      assert.exists(signer);
      expect(verify(key, digest, await signer.sign(digest))).toBe(true);
    },
  );

  it("commits the Secret Key of the key it gives, and nothing else", async () => {
    const store = newStore();
    const { result, commits } = await perform(store, generateKey, { scheme: ed25519.name });
    expect(commits).toEqual(await recordsOf(store));
    expect(commits).toHaveLength(1);
    const { data } = await readObject(store, commits[0] as Link<unknown>, secretKeys.schema);
    expect(data.key.link).toBe(result.data.key.link);
  });

  it("fails for a name no scheme has, and records nothing", async () => {
    const store = newStore();
    await expect(perform(store, generateKey, { scheme: "ed448" })).rejects.toThrow(/ed448/);
    expect(await recordsOf(store)).toEqual([]);
  });
});
