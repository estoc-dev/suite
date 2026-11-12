import { ed25519, eip191, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import {
  decodeObject,
  encodeObject,
  itself,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
  readObject,
  type ValueMap,
} from "@estoc/object";
import { array, link, schema, string } from "@estoc/schema";
import { assert, describe, expect, it } from "vitest";
import { decodeBundle, encodeBundle } from "../src/index.ts";

const { identities, signedIdentities, signatures, publish } = loadIdentity([ed25519, eip191]);

const rewritten = (bytes: Uint8Array, change: (data: ValueMap) => ValueMap) => {
  const { data, schema } = objectFormat.decode(bytes);
  return objectFormat.encode(new ObjectValue(schema, change(data)));
};

const note = schema("Note", { text: string() });
const links = schema("Links", { links: array(link()) });
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const hello = encodeObject(note, { text: "hello" });
const asAlice = signatures.actor(alice, await publish(alice, { at: 0 }));
const signature = await asAlice.sign(hello);
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = encodeObject(links, {
  links: [new LinkValue(signature.link), new LinkValue(hello.link), new LinkValue(linkOf(image))],
});

describe("a bundle", () => {
  it("gives blobs of several kinds back by their links together", () => {
    const bundle = decodeBundle(encodeBundle(root, [signature.bytes, hello.bytes]));
    expect([signature.link, hello.link].map((link) => bundle.get(link))).toEqual([signature.bytes, hello.bytes]);
  });

  it("gives a signature back as bytes that do not read as an object of another schema", () => {
    const bundle = decodeBundle(encodeBundle(root, [signature.bytes]));
    const bytes = bundle.get(linkOf(signature.bytes));
    assert.exists(bytes);
    // @ts-expect-error: refused at compile time too
    expect(() => decodeObject(bytes, note)).toThrow();
  });

  it("reads with a signature as its root, which links to the object it is over and to its signed identity", async () => {
    const bundle = decodeBundle(encodeBundle(signature, [hello.bytes, ...signature.signedIdentity.blobs]));
    expect(bundle.link).toBe(signature.link);
    const readSignature = await signatures.read(bundle.link, bundle, noIdentityVersions);
    expect(await signatures.verify(decodeObject(bundle.root, signatures.schema), bundle, noIdentityVersions)).toEqual(
      readSignature,
    );
    expect(readSignature.signedIdentity.identity).toEqual(identities.encode(alice.key, { at: 0 }));
    expect((await readObject(bundle, readSignature.object, note)).data).toEqual({ text: "hello" });
  });

  it("takes as its root a signed identity as it was read, and writes it as it was signed", async () => {
    const wallet = SoftwareSigner.fromSecretKey(eip191, new Uint8Array(32).fill(2));
    const signedIdentity = await publish(wallet, { agents: [alice.key] });
    const file = encodeBundle(signedIdentity, signedIdentity.blobs);
    expect(file.subarray(0, signedIdentity.bytes.length)).toEqual(signedIdentity.bytes);
    const bundle = decodeBundle(file);
    expect(bundle.link).toBe(signedIdentity.link);
    expect(await signedIdentities.read(bundle.link, bundle)).toEqual(signedIdentity);
  });

  it("reads with a signature that does not verify or whose signed identity is written to an unknown schema, as bytes", async () => {
    const changed = rewritten(signature.bytes, (fields) => {
      const bytes = fields.signature as Uint8Array;
      return { ...fields, signature: bytes.map((byte, at) => (at === bytes.length - 1 ? byte ^ 1 : byte)) };
    });
    const { data } = objectFormat.decode(signature.signedIdentity.bytes);
    const laterSchema = linkOf(objectFormat.encode(new ObjectValue(itself, { title: "A later signed identity" })));
    const later = objectFormat.encode(new ObjectValue(laterSchema, data));
    const unknown = rewritten(signature.bytes, (fields) => ({
      ...fields,
      signedIdentity: new LinkValue(linkOf(later)),
    }));
    const identityBytes = new Map([...signature.signedIdentity.blobs, later].map((bytes) => [linkOf(bytes), bytes]));
    for (const blob of [changed, unknown]) {
      await expect(async () =>
        signatures.verify(decodeObject(blob, signatures.schema), identityBytes, noIdentityVersions),
      ).rejects.toThrow();
      expect(decodeBundle(encodeBundle(root, [blob])).get(linkOf(blob))).toEqual(blob);
    }
  });

  it.each<[string, (bytes: Uint8Array) => Uint8Array]>([
    ["array", (bytes) => bytes.slice()],
    ["Node Buffer", (bytes) => Buffer.from(bytes)],
  ])("keeps the signature it checked when the given %s changes afterwards", async (_, given) => {
    const file = given(encodeBundle(root, [signature.bytes, hello.bytes, ...signature.signedIdentity.blobs]));
    const bundle = decodeBundle(file);
    file.fill(0x20);
    expect(bundle.root).toEqual(root.bytes);
    const readSignature = await signatures.read(signature.link, bundle, noIdentityVersions);
    expect(bundle.get(readSignature.object)).toEqual(hello.bytes);
  });
});
