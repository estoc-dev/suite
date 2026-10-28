import { type Scheme, type Signature, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { assert, describe, expect, it } from "vitest";
import {
  type Authorization,
  authorizationSchema,
  type Entry,
  loadAuthorizations,
  proxySchema,
  type Signed,
  type Standing,
} from "../src/index.ts";

const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const { signatures } = authorizations;
const { identities } = signatures;
const proxySchemaRead = await encodeSchema(proxySchema, defaultValidator);
const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const target = encodeObject(note, { text: "the terms" });
const other = encodeObject(note, { text: "other terms" });

const root = signer("eip191", 1);
const hot = signer("ed25519", 2);
const deputy = signer("solana-offchain", 3);
const stranger = signer("ed25519", 4);

const rootToHot = await authorizations.authorize(hot.identity, root);
const hotToDeputy = await authorizations.authorize(deputy.identity, hot);

type AnySigned = Signed<{ readonly bytes: Uint8Array; readonly link: Link<unknown> }>;
type Given = AnySigned | Entry;

const identityOf = (signer: SoftwareSigner) => identities.encode(signer.identity);
// The objects of every identity here, given with the blobs a test is about.
const identityBytes = [root, hot, deputy, stranger].map((signer) => identityOf(signer).bytes);
const parts = (given: Given) =>
  "blobs" in given ? [given.signature.bytes, ...given.blobs] : [given.object.bytes, given.signature.bytes];
const byLink = (blobs: readonly Uint8Array[]) =>
  new Map<string, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
const readEntry = (entry: Given, given: readonly Given[] = [], link: Link<unknown> = target.link) =>
  authorizations.readStanding(
    link,
    entry.signature.link,
    byLink([...identityBytes, ...parts(entry), ...given.flatMap(parts)]),
  );
const through = (chain: readonly Signed<Authorization>[], by: SoftwareSigner, link: Link<unknown> = target.link) =>
  authorizations.createActor(by, chain).sign(link);
const way = (principal: SoftwareSigner, ...agents: SoftwareSigner[]): Standing => ({
  principal: identityOf(principal),
  agents: agents.map(identityOf),
});
const signed = async <T extends { readonly link: Link<unknown> }>(
  object: T,
  by: SoftwareSigner,
): Promise<Signed<T>> => ({
  object,
  signature: await signatures.sign(object, by),
});
// A proxy written without the checks that an actor makes, as anyone could write one.
const unchecked = (
  chain: readonly { readonly signature: Signature }[],
  by: SoftwareSigner,
  link: Link<unknown> = target.link,
) =>
  signed(
    encodeObject(proxySchemaRead, {
      chain: chain.map(({ signature }) => ({ $link: signature.link })),
      target: { $link: link },
    }),
    by,
  );

describe("a standing", () => {
  it("by a direct signature is its signer's own, through no agents and with no blob but its signer's identity", async () => {
    const entry = await signed(target, root);
    const blobs = byLink([entry.signature.bytes, entry.signature.identity.bytes]);
    expect(await authorizations.readStanding(target.link, entry.signature.link, blobs)).toEqual(way(root));
  });

  it("through a proxy that a key signs is the wallet's that authorized the key", async () => {
    expect(await readEntry(await through([rootToHot], hot))).toEqual(way(root, hot));
  });

  it("passes along a chain of authorizations", async () => {
    expect(await readEntry(await through([rootToHot, hotToDeputy], deputy))).toEqual(way(root, hot, deputy));
  });

  it("by an agent's direct signature is the agent's own, as a witness's is", async () => {
    expect(await readEntry(await signed(target, hot), [rootToHot])).toEqual(way(hot));
  });

  it("is not read from a signature over another object", async () => {
    const entry = await signed(other, root);
    await expect(readEntry(entry)).rejects.toThrow(/the entry is for/);
  });
});

describe("a proxy", () => {
  it("counts for no one when signed by anyone but its chain's last agent", async () => {
    const { signature, blobs } = await through([rootToHot], hot);
    for (const by of [root, deputy]) {
      const entry = { signature: await signatures.sign({ link: signature.object }, by), blobs };
      await expect(readEntry(entry)).rejects.toThrow(/signed by the last agent/);
    }
  });

  it("counts for no one when its chain does not connect", async () => {
    const strangerToDeputy = await authorizations.authorize(deputy.identity, stranger);
    const proxy = await unchecked([rootToHot, strangerToDeputy], deputy);
    await expect(readEntry(proxy, [rootToHot, strangerToDeputy])).rejects.toThrow(
      /signed by the agent of the one before it/,
    );
  });

  it("counts for no one when its chain holds a signature over another schema's object of the same shape", async () => {
    const lookalike = await encodeSchema({ ...authorizationSchema, title: "Delegation" }, defaultValidator);
    const delegation = await signed(encodeObject(lookalike, { agent: { $link: identityOf(hot).link } }), root);
    const proxy = await unchecked([delegation], hot);
    await expect(readEntry(proxy, [delegation])).rejects.toThrow(/is written to/);
  });

  it("counts for no one when its chain holds a proxy", async () => {
    const inner = await through([rootToHot], hot, other.link);
    const proxy = await unchecked([inner], hot);
    await expect(readEntry(proxy, [rootToHot, inner])).rejects.toThrow(/is written to/);
  });

  it("counts for no one when its agent signs it only through another proxy", async () => {
    const proxy = encodeObject(proxySchemaRead, {
      chain: [{ $link: rootToHot.signature.link }],
      target: { $link: target.link },
    });
    const overProxy = await through([hotToDeputy], deputy, proxy.link);
    expect(await readEntry(overProxy, [rootToHot], proxy.link)).toEqual(way(hot, deputy));
    await expect(readEntry(overProxy, [rootToHot])).rejects.toThrow(/the entry is for/);
  });

  it("counts on its target and on no other object", async () => {
    const proxy = await through([rootToHot], hot, other.link);
    await expect(readEntry(proxy)).rejects.toThrow(/the entry is for/);
    expect(await readEntry(proxy, [], other.link)).toEqual(way(root, hot));
  });
});

describe("a standing through a proxy", () => {
  const names = [
    "first authorization",
    "signature over it",
    "second authorization",
    "signature over it",
    "proxy",
    "signature over it",
    "principal's identity",
    "first agent's identity",
    "second agent's identity",
  ];

  it.each(names.map((name, i) => [i, name] as const))("is not read without blob %i, the %s", async (missing) => {
    const proxy = await through([rootToHot, hotToDeputy], deputy);
    const proxyObject = byLink(proxy.blobs).get(proxy.signature.object);
    assert.exists(proxyObject);
    const identities = [root, hot, deputy].map((s) => identityOf(s).bytes);
    const blobs = [...parts(rootToHot), ...parts(hotToDeputy), proxyObject, proxy.signature.bytes, ...identities];
    const readFrom = (given: Uint8Array[]) =>
      authorizations.readStanding(target.link, proxy.signature.link, byLink(given));
    expect(await readFrom(blobs)).toEqual(way(root, hot, deputy));
    // Without the proxy, the entry reads as its signer's own over the proxy's link.
    const refusal = names[missing] === "proxy" ? /the entry is for/ : /no blob is given for/;
    await expect(readFrom(blobs.filter((_, i) => i !== missing))).rejects.toThrow(refusal);
  });

  it.each(["authorization", "signature over it", "proxy", "agent's identity"].map((name, i) => [i, name] as const))(
    "is not read when blob %i, the %s, is given as another of its kind",
    async (swapped) => {
      const rootToDeputy = await authorizations.authorize(deputy.identity, root);
      const [proxy, alike] = await Promise.all([through([rootToHot], hot), through([rootToDeputy], deputy)]);
      const blobs = byLink([...identityBytes, ...parts(proxy)]);
      const alikeObject = byLink(alike.blobs).get(alike.signature.object);
      assert.exists(alikeObject);
      const swaps: [string, Uint8Array][] = [
        [rootToHot.object.link, rootToDeputy.object.bytes],
        [rootToHot.signature.link, rootToDeputy.signature.bytes],
        [proxy.signature.object, alikeObject],
        [rootToHot.object.agent.link, identityOf(deputy).bytes],
      ];
      const swap = swaps[swapped];
      assert.exists(swap);
      blobs.set(...swap);
      await expect(authorizations.readStanding(target.link, proxy.signature.link, blobs)).rejects.toThrow(
        /is another blob/,
      );
    },
  );

  it("reads the same with blobs added that its entry does not lead to", async () => {
    const proxy = await through([rootToHot], hot);
    const direct = await signed(target, stranger);
    const forged = new TextDecoder().decode(direct.signature.bytes).replace(/"signature":"../, '"signature":"00');
    const junk = [
      new Uint8Array(0),
      utf8("not JSON"),
      utf8("{}"),
      utf8(forged),
      ...parts(direct),
      ...parts(hotToDeputy),
    ];
    const blobs = byLink([...junk, ...parts(proxy), ...junk]);
    expect(await authorizations.readStanding(target.link, proxy.signature.link, blobs)).toEqual(way(root, hot));
  });
});

describe("an entry read without its target", () => {
  const readWith = (entry: Given, blobs: readonly Uint8Array[] = parts(entry)) =>
    authorizations.readEntry(entry.signature.link, byLink([...identityBytes, ...blobs]));

  it("over an object stands its signer behind it, whether or not the object is given", async () => {
    const entry = await signed(target, root);
    expect(await readWith(entry)).toEqual({ target: target.link, ...way(root) });
    expect(await readWith(entry, [entry.signature.bytes])).toEqual({ target: target.link, ...way(root) });
  });

  it("over a proxy stands the chain's first authorizer behind the proxy's target", async () => {
    expect(await readWith(await through([rootToHot, hotToDeputy], deputy))).toEqual({
      target: target.link,
      ...way(root, hot, deputy),
    });
  });

  it("over a proxy that is not given stands its signer behind the proxy's link", async () => {
    const entry = await through([rootToHot], hot);
    const blobs = parts(entry).filter((bytes) => linkOf(bytes) !== entry.signature.object);
    expect(await readWith(entry, blobs)).toEqual({ target: entry.signature.object, ...way(hot) });
  });

  it("over a proxy that its chain's last agent did not sign stands no one behind anything", async () => {
    const { signature, blobs } = await through([rootToHot], hot);
    const entry = { signature: await signatures.sign({ link: signature.object }, root), blobs };
    await expect(readWith(entry)).rejects.toThrow(/signed by the last agent/);
  });
});
