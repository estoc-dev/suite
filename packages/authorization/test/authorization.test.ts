import { SoftwareSigner, type Scheme } from "@estoc/identity";
import { decodeObject, encodeObject, encodeSchema, identities, linkOf, schemaOf, sign, type Json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it, vi } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema, type Authorization, type Signed } from "../src/index.ts";
import { formatBlind } from "./format-blind.ts";

const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));

const authorizations = await loadAuthorizations(defaultValidator);
const authorization = await encodeSchema(authorizationSchema, defaultValidator);
const proxy = await encodeSchema(proxySchema, defaultValidator);
const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const target = encodeObject(note, "the terms");

const root = signer("eip191", 1);
const hot = signer("ed25519", 2);
const deputy = signer("solana-offchain", 3);
const stranger = signer("ed25519", 4);
const agent = identities.encode(hot.identity).link;
const byLink = (blobs: readonly Uint8Array[]) => new Map<string, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
const blobsOf = ({ object, signature }: Signed<Authorization>) => byLink([object.bytes, object.agent.bytes, signature.identity.bytes]);
const identityBytes = [root, hot, deputy].map(({ identity }) => identities.encode(identity).bytes);
const given = (...blobs: Uint8Array[]) => byLink([...identityBytes, ...blobs]);

describe("an authorization", () => {
  it.each([
    ["without an end", undefined],
    ["until an instant", "2027-01-01T00:00:00Z"],
    ["until an instant with fractional seconds", "2027-01-01T00:00:00.25Z"],
  ])("%s reads back from its blobs", async (_, until) => {
    const signed = await authorizations.authorize(hot.identity, root, until === undefined ? undefined : Temporal.Instant.from(until));
    const read = authorizations.readAuthorization(signed.signature.bytes, blobsOf(signed));
    expect(read.signature.identity).toEqual(identities.encode(root.identity));
    expect(read.object.agent).toEqual(identities.encode(hot.identity));
    expect(read.object.until?.toString()).toBe(until);
    expect(read.object.link).toBe(signed.object.link);
    expect(read.signature.link).toBe(signed.signature.link);
  });

  it("is written with its end in UTC, whatever offset the instant was given with", async () => {
    const signed = await authorizations.authorize(hot.identity, root, Temporal.Instant.from("2027-01-01T08:00:00+08:00"));
    const bytes: Uint8Array = signed.object.bytes;
    expect(decodeObject(bytes, authorization).data).toEqual({ agent, until: "2027-01-01T00:00:00Z" });
  });

  it("is not signed with an end past the year 9999, which RFC 3339 does not write", async () => {
    const asked = vi.fn((digest: Uint8Array) => root.sign(digest));
    const until = Temporal.Instant.from("+010000-01-01T00:00:00Z");
    await expect(authorizations.authorize(hot.identity, { identity: root.identity, sign: asked }, until)).rejects.toThrow(/does not fit/);
    expect(asked).not.toHaveBeenCalled();
  });

  it("is refused with an end that does not read as an instant, even by a validator that lets it through", async () => {
    const blind = await loadAuthorizations(formatBlind);
    const object = encodeObject(await encodeSchema(authorizationSchema, formatBlind), { agent, until: "2027-01-01" });
    const signature = await sign(object, root);
    expect(() => blind.readAuthorization(signature.bytes, given(object.bytes))).toThrow();
  });

  it("is refused when the blob given for its object is another authorization", async () => {
    const first = await authorizations.authorize(hot.identity, root);
    const second = await authorizations.authorize(deputy.identity, root);
    const blobs = given().set(first.object.link, second.object.bytes);
    expect(() => authorizations.readAuthorization(first.signature.bytes, blobs)).toThrow(/is another blob/);
  });

  it("is not read without the object of its agent", async () => {
    const signed = await authorizations.authorize(stranger.identity, root);
    expect(() => authorizations.readAuthorization(signed.signature.bytes, given(signed.object.bytes))).toThrow(/no blob is given/);
  });

  it("is refused when its object is written to another schema, though shaped the same", async () => {
    const lookalike = await encodeSchema({ ...authorizationSchema, title: "Delegation" }, defaultValidator);
    const object = encodeObject(lookalike, { agent });
    const signature = await sign(object, root);
    expect(() => authorizations.readAuthorization(signature.bytes, given(object.bytes))).toThrow(/not read here/);
  });
});

describe("the authorization schema", () => {
  it.each<[string, Json]>([
    ["an end that is a date only", { agent, until: "2027-01-01" }],
    ["an end without an offset", { agent, until: "2027-01-01T00:00:00" }],
    ["a field besides agent and until", { agent, scope: "all" }],
    ["no agent", { until: "2027-01-01T00:00:00Z" }],
    ["an agent that is not a link", { agent: "hot" }],
    ["an agent written in place of the link to it", { agent: { publicKey: "00", scheme: "ed25519" } }],
  ])("refuses %s", (_, data) => {
    expect(() => encodeObject(authorization, data)).toThrow();
  });
});

describe("the proxy schema", () => {
  const link = target.link;

  it.each<[string, Json]>([
    ["an empty chain", { chain: [], target: link }],
    ["a target that is not a link", { chain: [link], target: "the terms" }],
    ["a chain holding something other than a link", { chain: [link, "the grant"], target: link }],
    ["a field besides chain and target", { chain: [link], principal: agent, target: link }],
  ])("refuses %s", (_, data) => {
    expect(() => encodeObject(proxy, data)).toThrow();
  });
});

describe("proxy", () => {
  const grants = Promise.all([
    authorizations.authorize(hot.identity, root),
    authorizations.authorize(deputy.identity, hot),
    authorizations.authorize(deputy.identity, stranger),
  ]);

  it("signs a proxy over the chain's signatures, in order", async () => {
    const [toHot, toDeputy] = await grants;
    const signed = await authorizations.proxy(target.link, [toHot, toDeputy], deputy);
    expect(signed.object.chain).toEqual([toHot.signature.link, toDeputy.signature.link]);
    expect(signed.object.target).toBe(target.link);
    expect(schemaOf(signed.object.bytes)).toBe(proxy.link);
    expect(signed.signature.identity).toEqual(identities.encode(deputy.identity));
  });

  it("refuses an empty chain", async () => {
    await expect(authorizations.proxy(target.link, [], hot)).rejects.toThrow();
  });

  it("refuses a chain in which an authorization is not signed by the agent of the one before", async () => {
    const [toHot, , strangerToDeputy] = await grants;
    await expect(authorizations.proxy(target.link, [toHot, strangerToDeputy], deputy)).rejects.toThrow();
  });

  it("refuses a signer other than the chain's last agent", async () => {
    const [toHot, toDeputy] = await grants;
    const chains: [Signed<Authorization>[], SoftwareSigner][] = [
      [[toHot], root],
      [[toHot], deputy],
      [[toHot, toDeputy], hot],
    ];
    for (const [chain, by] of chains) await expect(authorizations.proxy(target.link, chain, by)).rejects.toThrow();
  });
});
