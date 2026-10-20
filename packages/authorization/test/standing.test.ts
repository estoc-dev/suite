import { identityToJson, SoftwareSigner, type Scheme } from "@estoc/identity";
import { encodeObject, encodeSchema, linkOf, sign, type EncodedObject, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema, type Signed, type Standing } from "../src/index.ts";
import { formatBlind } from "./format-blind.ts";

const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const utf8 = (text: string) => new TextEncoder().encode(text);

const authorizations = await loadAuthorizations(defaultValidator);
const proxySchemaRead = await encodeSchema(proxySchema, defaultValidator);
const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const target = encodeObject(note, "the terms");
const other = encodeObject(note, "other terms");

const root = signer("eip191", 1);
const hot = signer("ed25519", 2);
const deputy = signer("solana-offchain", 3);
const stranger = signer("ed25519", 4);
const now = new Date("2026-10-20T12:00:00Z");

const rootToHot = await authorizations.authorize(hot.identity, root);
const hotToDeputy = await authorizations.authorize(deputy.identity, hot);

const parts = ({ object, signature }: Signed) => [object.bytes, signature.bytes];
const byLink = (blobs: readonly Uint8Array[]) => new Map<string, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
// Reads the entry's signature, with its object and the blobs of `given` to look up.
const read = (entry: Signed, given: readonly Signed[] = [], at = now, link: Link<EncodedObject> = target.link) =>
  authorizations.readStanding(link, entry.signature.bytes, byLink([entry.object.bytes, ...given.flatMap(parts)]), at);
const way = (principal: SoftwareSigner, ...agents: SoftwareSigner[]): Standing => ({
  identity: principal.identity,
  agents: agents.map(({ identity }) => identity),
});
const signed = async (object: EncodedObject, by: SoftwareSigner): Promise<Signed> => ({ object, signature: await sign(object, by) });
// A proxy written without the checks that `proxy` makes, as anyone could write one.
const unchecked = (chain: readonly Signed[], by: SoftwareSigner, link: Link<EncodedObject> = target.link) =>
  signed(encodeObject(proxySchemaRead, { chain: chain.map(({ signature }) => signature.link), target: link }), by);

describe("a standing", () => {
  it("by a direct signature is its signer's own, through no agents and with no other blob", async () => {
    const entry = await signed(target, root);
    expect(authorizations.readStanding(target.link, entry.signature.bytes, new Map(), now)).toEqual(way(root));
  });

  it("through a proxy that a key signs is the wallet's that authorized the key", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot], hot);
    expect(read(proxy, [rootToHot])).toEqual(way(root, hot));
  });

  it("passes along a chain of authorizations", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot, hotToDeputy], deputy);
    expect(read(proxy, [rootToHot, hotToDeputy])).toEqual(way(root, hot, deputy));
  });

  it("by an agent's direct signature is the agent's own, as a witness's is", async () => {
    expect(read(await signed(target, hot), [rootToHot])).toEqual(way(hot));
  });

  it("is not read from a signature over another object", async () => {
    const entry = await signed(other, root);
    expect(() => read(entry)).toThrow(/is not written to/);
  });
});

describe("a proxy", () => {
  it("counts for no one when signed by anyone but its chain's last agent", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot], hot);
    for (const by of [root, deputy]) {
      const entry = await signed(proxy.object, by);
      expect(() => read(entry, [rootToHot])).toThrow(/signed by the last agent/);
    }
  });

  it("counts for no one when its chain does not connect", async () => {
    const strangerToDeputy = await authorizations.authorize(deputy.identity, stranger);
    const proxy = await unchecked([rootToHot, strangerToDeputy], deputy);
    expect(() => read(proxy, [rootToHot, strangerToDeputy])).toThrow(/signed by the agent of the one before it/);
  });

  it("counts for no one when its chain holds a signature over another schema's object of the same shape", async () => {
    const lookalike = await encodeSchema({ ...authorizationSchema, title: "Delegation" }, defaultValidator);
    const delegation = await signed(encodeObject(lookalike, { agent: identityToJson(hot.identity) }), root);
    const proxy = await unchecked([delegation], hot);
    expect(() => read(proxy, [delegation])).toThrow(/is not written to/);
  });

  it("counts for no one when its chain holds a proxy", async () => {
    const inner = await authorizations.proxy(other.link, [rootToHot], hot);
    const proxy = await unchecked([inner], hot);
    expect(() => read(proxy, [rootToHot, inner])).toThrow(/is not written to/);
  });

  it("counts for no one when its agent signs it only through another proxy", async () => {
    const proxy = encodeObject(proxySchemaRead, { chain: [rootToHot.signature.link], target: target.link });
    const overProxy = await authorizations.proxy(proxy.link, [hotToDeputy], deputy);
    const given = [rootToHot, hotToDeputy];
    expect(read(overProxy, given, now, proxy.link)).toEqual(way(hot, deputy));
    expect(() => read(overProxy, given)).toThrow(/the proxy is for/);
  });

  it("counts on its target and on no other object", async () => {
    const proxy = await authorizations.proxy(other.link, [rootToHot], hot);
    expect(() => read(proxy, [rootToHot])).toThrow(/the proxy is for/);
    expect(read(proxy, [rootToHot], now, other.link)).toEqual(way(root, hot));
  });

  it.each([0, 1])("counts for no one once authorization %i of its chain has ended", async (ended) => {
    const until = (i: number) => (i === ended ? "2026-10-20T11:59:59Z" : "2026-10-21T00:00:00Z");
    const first = await authorizations.authorize(hot.identity, root, until(0));
    const second = await authorizations.authorize(deputy.identity, hot, until(1));
    const proxy = await authorizations.proxy(target.link, [first, second], deputy);
    expect(() => read(proxy, [first, second])).toThrow(/ended at 2026-10-20T11:59:59Z/);
  });
});

describe("an authorization with an end", () => {
  // A reading, at a given time, of a proxy through an authorization that ends at `until`.
  const through = async (until: string) => {
    const grant = await authorizations.authorize(hot.identity, root, until);
    const proxy = await authorizations.proxy(target.link, [grant], hot);
    return (at: Date) => read(proxy, [grant], at);
  };

  it("counts while the reader's clock is before its end, and not from its end on", async () => {
    const readAt = await through("2026-10-20T12:00:01Z");
    expect(readAt(new Date("2026-10-20T12:00:00Z"))).toEqual(way(root, hot));
    expect(readAt(new Date("2026-10-20T12:00:00.999Z"))).toEqual(way(root, hot));
    expect(() => readAt(new Date("2026-10-20T12:00:01Z"))).toThrow(/ended at/);
    expect(() => readAt(new Date("2026-10-20T12:00:02Z"))).toThrow(/ended at/);
  });

  it("is compared as an instant, not as text, when written with an offset", async () => {
    // At 12:00:00Z, both ends sort later as text; only the first is later in time.
    expect((await through("2026-10-20T20:00:01+08:00"))(now)).toEqual(way(root, hot));
    const ended = await through("2026-10-20T19:59:59+08:00");
    expect(() => ended(now)).toThrow(/ended at/);
  });

  it("counts for no one when its end does not read as an instant, where the validator let it through", async () => {
    const blind = await loadAuthorizations(formatBlind);
    const [blindAuthorization, blindProxy] = await Promise.all(
      [authorizationSchema, proxySchema].map((schema) => encodeSchema(schema, formatBlind)),
    );
    const through = async (until: string) => {
      const grant = await signed(encodeObject(blindAuthorization!, { agent: identityToJson(hot.identity), until }), root);
      const proxy = await signed(encodeObject(blindProxy!, { chain: [grant.signature.link], target: target.link }), hot);
      return () => blind.readStanding(target.link, proxy.signature.bytes, byLink([...parts(grant), proxy.object.bytes]), now);
    };
    expect((await through("2027-01-01T00:00:00Z"))()).toEqual(way(root, hot));
    expect(await through("2027-01-01")).toThrow(RangeError);
  });
});

describe("a standing through a proxy", () => {
  const names = ["first authorization", "signature over it", "second authorization", "signature over it", "proxy"];

  it.each(names.map((name, i) => [i, name] as const))("is not read without blob %i, the %s", async (missing) => {
    const proxy = await authorizations.proxy(target.link, [rootToHot, hotToDeputy], deputy);
    const blobs = [...parts(rootToHot), ...parts(hotToDeputy), proxy.object.bytes];
    const readFrom = (given: Uint8Array[]) => authorizations.readStanding(target.link, proxy.signature.bytes, byLink(given), now);
    expect(readFrom(blobs)).toEqual(way(root, hot, deputy));
    expect(() => readFrom(blobs.filter((_, i) => i !== missing))).toThrow(/no blob is given for/);
  });

  it.each(["authorization", "signature over it", "proxy"].map((name, i) => [i, name] as const))(
    "is not read when blob %i, the %s, is given as another of its kind",
    async (swapped) => {
      const lasting = await authorizations.authorize(hot.identity, root, "2027-01-01T00:00:00Z");
      const [proxy, alike] = await Promise.all([rootToHot, lasting].map((grant) => authorizations.proxy(target.link, [grant], hot)));
      const blobs = byLink([...parts(rootToHot), proxy!.object.bytes]);
      const links = [rootToHot.object.link, rootToHot.signature.link, proxy!.object.link];
      blobs.set(links[swapped]!, [...parts(lasting), alike!.object.bytes][swapped]!);
      expect(() => authorizations.readStanding(target.link, proxy!.signature.bytes, blobs, now)).toThrow(/is another blob/);
    },
  );

  it("reads the same with blobs added that its entry does not lead to", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot], hot);
    const direct = await signed(target, stranger);
    const forged = new TextDecoder().decode(direct.signature.bytes).replace(/"signature":"../, '"signature":"00');
    const junk = [new Uint8Array(0), utf8("not JSON"), utf8("{}"), utf8(forged), ...parts(direct), ...parts(hotToDeputy)];
    const blobs = byLink([...junk, ...parts(rootToHot), proxy.object.bytes, ...junk]);
    expect(authorizations.readStanding(target.link, proxy.signature.bytes, blobs, now)).toEqual(way(root, hot));
  });
});
