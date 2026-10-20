import { identityToJson, SoftwareSigner, type Scheme } from "@estoc/identity";
import { encodeObject, encodeSchema, sign, type EncodedObject, type Link } from "@estoc/object";
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

const blobs = (...signed: Signed[]) => signed.flatMap(({ object, signature }) => [object.bytes, signature.bytes]);
const standing = (evidence: Iterable<Uint8Array>, at = now, link: Link<EncodedObject> = target.link) =>
  authorizations.standingBehind(link, authorizations.evidenceFrom(evidence), at);
const way = (principal: SoftwareSigner, ...agents: SoftwareSigner[]): Standing => ({
  identity: principal.identity,
  agents: agents.map(({ identity }) => identity),
});
const signed = async (object: EncodedObject, by: SoftwareSigner): Promise<Signed> => ({ object, signature: await sign(object, by) });
// A proxy written without the checks that `proxy` makes, as anyone could write one.
const unchecked = (chain: readonly Signed[], by: SoftwareSigner, link: Link<EncodedObject> = target.link) =>
  signed(encodeObject(proxySchemaRead, { chain: chain.map(({ signature }) => signature.link), target: link }), by);

describe("standing behind an object", () => {
  it("is had by whoever signs it directly, through no agents", async () => {
    expect(standing(blobs(await signed(target, root)))).toEqual([way(root)]);
  });

  it("is had by a wallet's identity through a proxy that the key it authorized signs", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot], hot);
    expect(standing(blobs(rootToHot, proxy))).toEqual([way(root, hot)]);
  });

  it("passes along a chain of authorizations", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot, hotToDeputy], deputy);
    expect(standing(blobs(rootToHot, hotToDeputy, proxy))).toEqual([way(root, hot, deputy)]);
  });

  it("is had only by an agent itself when it signs the object directly, as a witness would", async () => {
    expect(standing(blobs(rootToHot, await signed(target, hot)))).toEqual([way(hot)]);
  });

  it("is listed once for each way: a direct signature and a proxy are two, two proxies through the same agents one", async () => {
    const lasting = await authorizations.authorize(hot.identity, root, "2027-01-01T00:00:00Z");
    const proxies = await Promise.all([rootToHot, lasting].map((grant) => authorizations.proxy(target.link, [grant], hot)));
    expect(proxies[0]!.object.link).not.toBe(proxies[1]!.object.link);
    const evidence = blobs(await signed(target, root), rootToHot, lasting, ...proxies);
    expect(standing(evidence)).toEqual([way(root), way(root, hot)]);
  });
});

describe("a proxy", () => {
  it("counts for nothing when signed by anyone but its chain's last agent", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot], hot);
    for (const by of [root, deputy]) {
      expect(standing(blobs(rootToHot, await signed(proxy.object, by)))).toEqual([]);
    }
  });

  it("counts for nothing when its chain does not connect", async () => {
    const strangerToDeputy = await authorizations.authorize(deputy.identity, stranger);
    const proxy = await unchecked([rootToHot, strangerToDeputy], deputy);
    expect(standing(blobs(rootToHot, strangerToDeputy, proxy))).toEqual([]);
  });

  it("counts for nothing when its chain holds a signature over another schema's object of the same shape", async () => {
    const lookalike = await encodeSchema({ ...authorizationSchema, title: "Delegation" }, defaultValidator);
    const delegation = await signed(encodeObject(lookalike, { agent: identityToJson(hot.identity) }), root);
    expect(standing(blobs(delegation, await unchecked([delegation], hot)))).toEqual([]);
  });

  it("counts for nothing when its chain holds a proxy", async () => {
    const inner = await authorizations.proxy(other.link, [rootToHot], hot);
    expect(standing(blobs(rootToHot, inner, await unchecked([inner], hot)))).toEqual([]);
  });

  it("counts for nothing when its agent signs it only through another proxy", async () => {
    const proxy = encodeObject(proxySchemaRead, { chain: [rootToHot.signature.link], target: target.link });
    const overProxy = await authorizations.proxy(proxy.link, [hotToDeputy], deputy);
    const evidence = [...blobs(rootToHot, hotToDeputy, overProxy), proxy.bytes];
    expect(standing(evidence, now, proxy.link)).toEqual([way(hot, deputy)]);
    expect(standing(evidence)).toEqual([]);
  });

  it("counts on its target and on no other object", async () => {
    const proxy = await authorizations.proxy(other.link, [rootToHot], hot);
    expect(standing(blobs(rootToHot, proxy))).toEqual([]);
    expect(standing(blobs(rootToHot, proxy), now, other.link)).toEqual([way(root, hot)]);
  });

  it.each([0, 1])("counts for nothing once authorization %i of its chain has ended", async (ended) => {
    const until = (i: number) => (i === ended ? "2026-10-20T11:59:59Z" : "2026-10-21T00:00:00Z");
    const first = await authorizations.authorize(hot.identity, root, until(0));
    const second = await authorizations.authorize(deputy.identity, hot, until(1));
    const proxy = await authorizations.proxy(target.link, [first, second], deputy);
    expect(standing(blobs(first, second, proxy))).toEqual([]);
  });
});

describe("an authorization with an end", () => {
  const through = async (until: string) => {
    const grant = await authorizations.authorize(hot.identity, root, until);
    return blobs(grant, await authorizations.proxy(target.link, [grant], hot));
  };

  it("counts while the reader's clock is before its end, and not from its end on", async () => {
    const evidence = await through("2026-10-20T12:00:01Z");
    expect(standing(evidence, new Date("2026-10-20T12:00:00Z"))).toEqual([way(root, hot)]);
    expect(standing(evidence, new Date("2026-10-20T12:00:00.999Z"))).toEqual([way(root, hot)]);
    expect(standing(evidence, new Date("2026-10-20T12:00:01Z"))).toEqual([]);
    expect(standing(evidence, new Date("2026-10-20T12:00:02Z"))).toEqual([]);
  });

  it("is compared as an instant, not as text, when written with an offset", async () => {
    // At 12:00:00Z, both ends sort later as text; only the first is later in time.
    expect(standing(await through("2026-10-20T20:00:01+08:00"))).toEqual([way(root, hot)]);
    expect(standing(await through("2026-10-20T19:59:59+08:00"))).toEqual([]);
  });

  it("counts for nothing when its end does not read as an instant, where the validator let it through", async () => {
    const blind = await loadAuthorizations(formatBlind);
    const [blindAuthorization, blindProxy] = await Promise.all(
      [authorizationSchema, proxySchema].map((schema) => encodeSchema(schema, formatBlind)),
    );
    const read = async (until: string) => {
      const grant = await signed(encodeObject(blindAuthorization!, { agent: identityToJson(hot.identity), until }), root);
      const proxy = await signed(encodeObject(blindProxy!, { chain: [grant.signature.link], target: target.link }), hot);
      return blind.standingBehind(target.link, blind.evidenceFrom(blobs(grant, proxy)), now);
    };
    expect(await read("2027-01-01T00:00:00Z")).toEqual([way(root, hot)]);
    expect(await read("2027-01-01")).toEqual([]);
  });
});

describe("evidence", () => {
  const parts = ["first authorization", "signature over it", "second authorization", "signature over it", "proxy", "signature over it"];

  it.each(parts.map((part, i) => [i, part] as const))(
    "missing blob %i, the %s, leaves out that way and keeps the others",
    async (missing) => {
      const proxy = await authorizations.proxy(target.link, [rootToHot, hotToDeputy], deputy);
      const evidence = blobs(rootToHot, hotToDeputy, proxy, await signed(target, stranger));
      expect(standing(evidence)).toEqual([way(stranger), way(root, hot, deputy)]);
      expect(standing(evidence.filter((_, i) => i !== missing))).toEqual([way(stranger)]);
    },
  );

  it("with blobs added that read as nothing gives the same ways", async () => {
    const proxy = await authorizations.proxy(target.link, [rootToHot], hot);
    const forged = new TextDecoder().decode((await signed(target, stranger)).signature.bytes).replace(/"signature":"../, '"signature":"00');
    const junk = [new Uint8Array(0), utf8("not JSON"), utf8("{}"), utf8(` ${new TextDecoder().decode(proxy.object.bytes)}`), utf8(forged)];
    expect(standing([...junk, ...blobs(rootToHot, proxy), ...junk])).toEqual([way(root, hot)]);
  });
});
