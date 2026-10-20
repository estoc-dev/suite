import { identityToJson, SoftwareSigner, type Scheme } from "@estoc/identity";
import { encodeObject, encodeSchema, sign, type Json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { authorizationSchema, loadAuthorizations, proxySchema, type Authorization } from "../src/index.ts";
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
const agent = identityToJson(hot.identity);

describe("an authorization", () => {
  it.each([
    ["without an end", undefined],
    ["until an instant in UTC", "2027-01-01T00:00:00Z"],
    ["until an instant written with an offset and fractional seconds", "2027-01-01T08:00:00.25+08:00"],
  ])("%s reads back from its blobs", async (_, until) => {
    const signed = await authorizations.authorize(hot.identity, root, until);
    const read = authorizations.readAuthorization(signed.signature.bytes, signed.object.bytes);
    expect(read.authorizer).toEqual(root.identity);
    expect(read.agent).toEqual(hot.identity);
    expect(read.object.data).toEqual(until === undefined ? { agent } : { agent, until });
    expect(read.object.link).toBe(signed.object.link);
    expect(read.signature.link).toBe(signed.signature.link);
  });

  it("is refused with an end that does not read as an instant, even by a validator that lets it through", async () => {
    const blind = await loadAuthorizations(formatBlind);
    await expect(blind.authorize(hot.identity, root, "2027-01-01")).rejects.toThrow();
    const object = encodeObject(await encodeSchema(authorizationSchema, formatBlind), { agent, until: "2027-01-01" });
    const signature = await sign(object, root);
    expect(() => blind.readAuthorization(signature.bytes, object.bytes)).toThrow();
  });

  it("is refused when its signature is over another object", async () => {
    const first = await authorizations.authorize(hot.identity, root);
    const second = await authorizations.authorize(deputy.identity, root);
    expect(() => authorizations.readAuthorization(first.signature.bytes, second.object.bytes)).toThrow();
  });

  it("is refused when its object is written to another schema, though shaped the same", async () => {
    const lookalike = await encodeSchema({ ...authorizationSchema, title: "Delegation" }, defaultValidator);
    const object = encodeObject(lookalike, { agent });
    const signature = await sign(object, root);
    expect(() => authorizations.readAuthorization(signature.bytes, object.bytes)).toThrow();
  });
});

describe("the authorization schema", () => {
  it.each<[string, Json]>([
    ["an end that is a date only", { agent, until: "2027-01-01" }],
    ["an end without an offset", { agent, until: "2027-01-01T00:00:00" }],
    ["a field besides agent and until", { agent, scope: "all" }],
    ["no agent", { until: "2027-01-01T00:00:00Z" }],
    ["an agent that is not an identity", { agent: { ...agent, publicKey: "00" } }],
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
    expect(signed.object.data).toEqual({ chain: [toHot.signature.link, toDeputy.signature.link], target: target.link });
    expect(signed.object.schema.link).toBe(proxy.link);
    expect(signed.signature.identity).toEqual(deputy.identity);
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
    const chains: [Authorization[], SoftwareSigner][] = [
      [[toHot], root],
      [[toHot], deputy],
      [[toHot, toDeputy], hot],
    ];
    for (const [chain, by] of chains) await expect(authorizations.proxy(target.link, chain, by)).rejects.toThrow();
  });
});
