import { type Scheme, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, type JsonObject, linkOf, readObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Authorization, authorizationSchema, loadAuthorizations, proxySchema, type Signed } from "../src/index.ts";

const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));

const authorizations = await loadAuthorizations(defaultValidator);
const { signatures } = authorizations;
const { identities } = signatures;
const authorization = await encodeSchema(authorizationSchema, defaultValidator);
const proxy = await encodeSchema(proxySchema, defaultValidator);
const note = await encodeSchema(
  { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const target = encodeObject(note, { text: "the terms" });

const root = signer("eip191", 1);
const hot = signer("ed25519", 2);
const deputy = signer("solana-offchain", 3);
const stranger = signer("ed25519", 4);
const agent = { $link: identities.encode(hot.key).link };
const actorOf = async (by: SoftwareSigner) => signatures.actor(by, await identities.publish(by));
const authorize = async (agent: SoftwareSigner, by: SoftwareSigner) =>
  authorizations.authorize(agent.key, await actorOf(by));
const createActor = async (by: SoftwareSigner, chain: readonly Signed<Authorization>[] = []) =>
  authorizations.createActor(await actorOf(by), chain);
const byLink = (blobs: readonly Uint8Array[]) =>
  new Map<string, Uint8Array>(blobs.map((bytes) => [linkOf(bytes), bytes]));
const blobsOf = ({ object, signature }: Signed<Authorization>) =>
  byLink([signature.bytes, object.bytes, ...object.agent.blobs, ...signature.identity.blobs]);
const identityBlobs = (await Promise.all([root, hot, deputy].map((by) => identities.publish(by)))).flatMap(
  ({ blobs }) => blobs,
);
const given = (...blobs: Uint8Array[]) => byLink([...identityBlobs, ...blobs]);

describe("an authorization", () => {
  it("reads back from its blobs", async () => {
    const signed = await authorize(hot, root);
    const read = await authorizations.readAuthorization(signed.signature.link, blobsOf(signed));
    expect(read.signature.identity.identity).toEqual(identities.encode(root.key));
    expect(read.object.agent).toEqual(identities.encode(hot.key));
    expect(read.object.link).toBe(signed.object.link);
    expect(read.signature.link).toBe(signed.signature.link);
  });

  it("is refused when the blob given for its object is another authorization", async () => {
    const first = await authorize(hot, root);
    const second = await authorize(deputy, root);
    const blobs = given(first.signature.bytes).set(first.object.link, second.object.bytes);
    await expect(authorizations.readAuthorization(first.signature.link, blobs)).rejects.toThrow(/is another blob/);
  });

  it("is not read without the blobs of its agent", async () => {
    const signed = await authorize(stranger, root);
    await expect(
      authorizations.readAuthorization(signed.signature.link, given(signed.signature.bytes, signed.object.bytes)),
    ).rejects.toThrow(/no blob is given/);
  });

  it("is refused when its object is written to another schema, though shaped the same", async () => {
    const lookalike = await encodeSchema({ ...authorizationSchema, title: "Delegation" }, defaultValidator);
    const object = encodeObject(lookalike, { agent });
    const signature = await (await actorOf(root)).sign(object);
    await expect(
      authorizations.readAuthorization(signature.link, given(signature.bytes, object.bytes)),
    ).rejects.toThrow(/is written to/);
  });
});

describe("the authorization schema", () => {
  it.each<[string, JsonObject]>([
    ["a field besides agent", { agent, until: "2027-01-01T00:00:00Z" }],
    ["no agent", {}],
    ["an agent that is not a link", { agent: { $link: "hot" } }],
    ["an agent's link as a bare string", { agent: agent.$link }],
    ["an agent written in place of the link to it", { agent: { publicKey: "00" } }],
  ])("refuses %s", (_, data) => {
    expect(() => encodeObject(authorization, data)).toThrow();
  });
});

describe("the proxy schema", () => {
  const link = { $link: target.link };

  it.each<[string, JsonObject]>([
    ["an empty chain", { chain: [], target: link }],
    ["a target that is not a link", { chain: [link], target: { $link: "the terms" } }],
    ["a target's link as a bare string", { chain: [link], target: target.link }],
    ["a chain holding something other than a link", { chain: [link, { $link: "the grant" }], target: link }],
    ["a field besides chain and target", { chain: [link], principal: agent, target: link }],
  ])("refuses %s", (_, data) => {
    expect(() => encodeObject(proxy, data)).toThrow();
  });
});

describe("an actor", () => {
  const grants = Promise.all([authorize(hot, root), authorize(deputy, hot), authorize(deputy, stranger)]);

  it("without a chain stands behind a target for its own identity by its own signature", async () => {
    const actor = await createActor(root);
    const { signature, blobs } = await actor.sign(target.link);
    expect(actor).toMatchObject({ principal: identities.encode(root.key), agents: [] });
    expect(signature.object).toBe(target.link);
    expect(signature.identity.identity).toEqual(identities.encode(root.key));
    expect(blobs).toEqual(signature.identity.blobs);
  });

  it("with a chain stands behind a target for the chain's first authorizer by a proxy over the chain's signatures, in order", async () => {
    const [toHot, toDeputy] = await grants;
    const actor = await createActor(deputy, [toHot, toDeputy]);
    const { signature, blobs } = await actor.sign(target.link);
    expect(actor).toMatchObject({
      principal: identities.encode(root.key),
      agents: [hot, deputy].map(({ key }) => identities.encode(key)),
    });
    expect((await readObject(byLink(blobs), signature.object, proxy)).data).toEqual({
      chain: [toHot, toDeputy].map(({ signature }) => ({ $link: signature.link })),
      target: { $link: target.link },
    });
    expect(signature.identity.identity).toEqual(identities.encode(deputy.key));
  });

  it("gives each blob that its entry leads to besides the entry, with the identities' schemas, once, and no other", async () => {
    const [toHot, toDeputy] = await grants;
    const { signature, blobs } = await (await createActor(deputy, [toHot, toDeputy])).sign(target.link);
    const taken = [
      ...[toHot, toDeputy].flatMap(({ object, signature }) => [object.link, signature.link]),
      signature.object,
    ];
    const identityLinks = identityBlobs.map((blob) => linkOf(blob));
    expect(blobs.map((blob) => linkOf(blob)).sort()).toEqual([...new Set([...taken, ...identityLinks])].sort());
  });

  it.each([
    [0, root],
    [1, hot],
    [2, deputy],
  ] as const)(
    "reads back from its entry and blobs alone as its own standing, through %i agents",
    async (length, by) => {
      const [toHot, toDeputy] = await grants;
      const actor = await createActor(by, [toHot, toDeputy].slice(0, length));
      const { signature, blobs } = await actor.sign(target.link);
      const read = await authorizations.readStanding(target.link, signature.link, byLink([signature.bytes, ...blobs]));
      expect(read).toEqual({ principal: actor.principal, agents: actor.agents });
    },
  );

  it("is not made from a chain in which an authorization is not signed by the agent of the one before", async () => {
    const [toHot, , strangerToDeputy] = await grants;
    await expect(createActor(deputy, [toHot, strangerToDeputy])).rejects.toThrow(
      /signed by the agent of the one before it/,
    );
  });

  it("is not made for an identity other than the chain's last agent", async () => {
    const [toHot, toDeputy] = await grants;
    const chains: [Signed<Authorization>[], SoftwareSigner][] = [
      [[toHot], root],
      [[toHot], deputy],
      [[toHot, toDeputy], hot],
    ];
    for (const [chain, by] of chains) await expect(createActor(by, chain)).rejects.toThrow(/signed by the last agent/);
  });
});
