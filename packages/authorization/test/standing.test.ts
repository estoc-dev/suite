import { SoftwareSigner, type Scheme } from "@estoc/identity";
import { encodeObject, encodeSchema, linkOf, type Link, type Signature } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema, type Authorization, type Entry, type Signed, type Standing } from "../src/index.ts";
import { formatBlind } from "./format-blind.ts";

const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const { signatures } = authorizations;
const { identities } = signatures;
const authorizationSchemaRead = await encodeSchema(authorizationSchema, defaultValidator);
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
const now = new Date("2026-10-20T12:00:00Z");

const rootToHot = await authorizations.authorize(hot.identity, root);
const hotToDeputy = await authorizations.authorize(deputy.identity, hot);

type AnySigned = Signed<{ readonly bytes: Uint8Array; readonly link: Link<unknown> }>;
type Given = AnySigned | Entry;

const identityOf = (signer: SoftwareSigner) => identities.encode(signer.identity);
// The objects of every identity here, given with the blobs a test is about.
const identityBytes = [root, hot, deputy, stranger].map((signer) => identityOf(signer).bytes);
const parts = (given: Given) => ("blobs" in given ? [given.signature.bytes, ...given.blobs] : [given.object.bytes, given.signature.bytes]);
const byLink = (blobs: readonly Uint8Array[]) => new Map<string, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
const readEntry = (entry: Given, given: readonly Given[] = [], at = now, link: Link<unknown> = target.link) =>
  authorizations.readStanding(link, entry.signature.link, byLink([...identityBytes, ...parts(entry), ...given.flatMap(parts)]), at);
const through = (chain: readonly Signed<Authorization>[], by: SoftwareSigner, link: Link<unknown> = target.link) =>
  authorizations.actor(by, chain).stand(link);
const way = (principal: SoftwareSigner, ...agents: SoftwareSigner[]): Standing => ({
  principal: identityOf(principal),
  agents: agents.map(identityOf),
});
const signed = async <T extends { readonly link: Link<unknown> }>(object: T, by: SoftwareSigner): Promise<Signed<T>> => ({
  object,
  signature: await signatures.sign(object, by),
});
// A proxy written without the checks that an actor makes, as anyone could write one.
const unchecked = (chain: readonly { readonly signature: Signature }[], by: SoftwareSigner, link: Link<unknown> = target.link) =>
  signed(encodeObject(proxySchemaRead, { chain: chain.map(({ signature }) => ({ $link: signature.link })), target: { $link: link } }), by);

describe("a standing", () => {
  it("by a direct signature is its signer's own, through no agents and with no blob but its signer's identity", async () => {
    const entry = await signed(target, root);
    const blobs = byLink([entry.signature.bytes, entry.signature.identity.bytes]);
    expect(await authorizations.readStanding(target.link, entry.signature.link, blobs, now)).toEqual(way(root));
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
    await expect(readEntry(entry)).rejects.toThrow(/is written to/);
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
    await expect(readEntry(proxy, [rootToHot, strangerToDeputy])).rejects.toThrow(/signed by the agent of the one before it/);
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
    const proxy = encodeObject(proxySchemaRead, { chain: [{ $link: rootToHot.signature.link }], target: { $link: target.link } });
    const overProxy = await through([hotToDeputy], deputy, proxy.link);
    expect(await readEntry(overProxy, [rootToHot], now, proxy.link)).toEqual(way(hot, deputy));
    await expect(readEntry(overProxy, [rootToHot])).rejects.toThrow(/the proxy is for/);
  });

  it("counts on its target and on no other object", async () => {
    const proxy = await through([rootToHot], hot, other.link);
    await expect(readEntry(proxy)).rejects.toThrow(/the proxy is for/);
    expect(await readEntry(proxy, [], now, other.link)).toEqual(way(root, hot));
  });

  it.each([0, 1])("counts for no one once authorization %i of its chain has ended", async (ended) => {
    const until = (i: number) => Temporal.Instant.from(i === ended ? "2026-10-20T11:59:59Z" : "2026-10-21T00:00:00Z");
    const first = await authorizations.authorize(hot.identity, root, until(0));
    const second = await authorizations.authorize(deputy.identity, hot, until(1));
    await expect(readEntry(await through([first, second], deputy))).rejects.toThrow(/ended at 2026-10-20T11:59:59Z/);
  });
});

describe("an authorization with an end", () => {
  const readThrough = async (grant: Signed<Authorization>) => {
    const proxy = await through([grant], hot);
    return (at: Date) => readEntry(proxy, [], at);
  };
  // Written as another application could write it, with its end in any form RFC 3339 allows.
  const writtenUntil = async (until: string) => {
    const grant = await signed(encodeObject(authorizationSchemaRead, { agent: { $link: identityOf(hot).link }, until }), root);
    return authorizations.readAuthorization(grant.signature.link, byLink([...identityBytes, ...parts(grant)]));
  };

  it("counts while the reader's clock is before its end, and not from its end on", async () => {
    const readAt = await readThrough(await authorizations.authorize(hot.identity, root, Temporal.Instant.from("2026-10-20T12:00:01Z")));
    expect(await readAt(new Date("2026-10-20T12:00:00Z"))).toEqual(way(root, hot));
    expect(await readAt(new Date("2026-10-20T12:00:00.999Z"))).toEqual(way(root, hot));
    await expect(readAt(new Date("2026-10-20T12:00:01Z"))).rejects.toThrow(/ended at/);
    await expect(readAt(new Date("2026-10-20T12:00:02Z"))).rejects.toThrow(/ended at/);
  });

  it("is compared as an instant, not as text, when written with an offset", async () => {
    // At 12:00:00Z, both ends sort later as text; only the first is later in time.
    expect(await (await readThrough(await writtenUntil("2026-10-20T20:00:01+08:00")))(now)).toEqual(way(root, hot));
    const ended = await readThrough(await writtenUntil("2026-10-20T19:59:59+08:00"));
    await expect(ended(now)).rejects.toThrow(/ended at/);
  });

  it("counts for no one when its end does not read as an instant, where the validator let it through", async () => {
    const blind = await loadAuthorizations(formatBlind);
    const [blindAuthorization, blindProxy] = await Promise.all(
      [authorizationSchema, proxySchema].map((schema) => encodeSchema(schema, formatBlind)),
    );
    const blindReadThroughUntil = async (until: string) => {
      const grant = await signed(encodeObject(blindAuthorization!, { agent: { $link: identityOf(hot).link }, until }), root);
      const proxy = await signed(
        encodeObject(blindProxy!, { chain: [{ $link: grant.signature.link }], target: { $link: target.link } }),
        hot,
      );
      const blobs = byLink([...identityBytes, ...parts(grant), ...parts(proxy)]);
      return () => blind.readStanding(target.link, proxy.signature.link, blobs, now);
    };
    expect(await (await blindReadThroughUntil("2027-01-01T00:00:00Z"))()).toEqual(way(root, hot));
    await expect((await blindReadThroughUntil("2027-01-01"))()).rejects.toThrow(RangeError);
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
    const proxyObject = byLink(proxy.blobs).get(proxy.signature.object)!;
    const identities = [root, hot, deputy].map((s) => identityOf(s).bytes);
    const blobs = [...parts(rootToHot), ...parts(hotToDeputy), proxyObject, proxy.signature.bytes, ...identities];
    const readFrom = (given: Uint8Array[]) => authorizations.readStanding(target.link, proxy.signature.link, byLink(given), now);
    expect(await readFrom(blobs)).toEqual(way(root, hot, deputy));
    await expect(readFrom(blobs.filter((_, i) => i !== missing))).rejects.toThrow(/no blob is given for/);
  });

  it.each(["authorization", "signature over it", "proxy", "agent's identity"].map((name, i) => [i, name] as const))(
    "is not read when blob %i, the %s, is given as another of its kind",
    async (swapped) => {
      const lasting = await authorizations.authorize(hot.identity, root, Temporal.Instant.from("2027-01-01T00:00:00Z"));
      const [proxy, alike] = await Promise.all([rootToHot, lasting].map((grant) => through([grant], hot)));
      const blobs = byLink([...identityBytes, ...parts(proxy!)]);
      const links = [rootToHot.object.link, rootToHot.signature.link, proxy!.signature.object, rootToHot.object.agent.link];
      blobs.set(links[swapped]!, [...parts(lasting), byLink(alike!.blobs).get(alike!.signature.object)!, identityOf(deputy).bytes][swapped]!);
      await expect(authorizations.readStanding(target.link, proxy!.signature.link, blobs, now)).rejects.toThrow(/is another blob/);
    },
  );

  it("reads the same with blobs added that its entry does not lead to", async () => {
    const proxy = await through([rootToHot], hot);
    const direct = await signed(target, stranger);
    const forged = new TextDecoder().decode(direct.signature.bytes).replace(/"signature":"../, '"signature":"00');
    const junk = [new Uint8Array(0), utf8("not JSON"), utf8("{}"), utf8(forged), ...parts(direct), ...parts(hotToDeputy)];
    const blobs = byLink([...junk, ...parts(proxy), ...junk]);
    expect(await authorizations.readStanding(target.link, proxy.signature.link, blobs, now)).toEqual(way(root, hot));
  });
});
