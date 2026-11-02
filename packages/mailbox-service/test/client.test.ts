import { packBundle, unpackBundle } from "@estoc/bundle";
import { type Actor, ed25519, eip191, noVersions, type Signer, solanaOffchain } from "@estoc/identity";
import { type EncodedObject, encodeObject, encodeSchema, type Json, type Link, readObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import type { Store } from "@estoc/store";
import { afterEach, assert, describe, expect, it } from "vitest";
import { loadServices, type Services } from "../src/index.ts";
import type { MailboxService } from "../src/server.ts";
import {
  acknowledgementSchemaRead,
  actorOf,
  delegate,
  keys,
  memoryService,
  memoryStore,
  offerSchema,
  serve,
  serviceIdentity,
  serviceRoot,
  serviceSchemaRead,
  serviceSigner,
  signatures,
  signedAtOrigins,
  signer,
} from "./fixtures.ts";

const alice = signer(ed25519, 1);
const bob = signer(ed25519, 5);
const wallet = signer(eip191, 2);
const laptop = signer(ed25519, 3);
const phone = signer(solanaOffchain, 4);
const mallory = signer(ed25519, 6);

const offer = encodeObject(offerSchema, { identity: { $link: serviceRoot.link } });

const agentOf = async (agent: Signer, root: Signer) => signatures.actor(agent, await delegate(root, [agent.key]));

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => void (await Promise.all(servers.splice(0).map((server) => server.close()))));

/** Serves at an origin of 127.0.0.1 what `handle` makes, given that origin, for each request. */
async function serving(handle: (request: Request, origin: string) => Promise<Response>) {
  const server = await serve((request) => handle(request, server.origin));
  servers.push(server);
  return server;
}

/**
 * Runs a service in memory at an origin of 127.0.0.1, which it is loaded
 * with, and answers a `POST` as `answer` does when it is given.
 */
async function running(
  options: Parameters<typeof memoryService>[0] = {},
  answer?: (service: MailboxService, request: Request) => Promise<Response>,
) {
  let loaded: Awaited<ReturnType<typeof memoryService>> | undefined;
  const server = await serving(async (request) => {
    assert.exists(loaded);
    return answer !== undefined && request.method === "POST"
      ? answer(loaded.service, request)
      : loaded.service.fetch(request);
  });
  loaded = await memoryService({ ...options, origin: server.origin });
  return { ...loaded, origin: server.origin, close: () => server.close() };
}

async function mine(store: Store) {
  const links: Link<never>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links.sort();
}

async function client() {
  const store = memoryStore();
  return { store, services: await loadServices(store, { validator: defaultValidator }) };
}

async function accountAt(services: Services, origin: string) {
  const { account } = await services.at(origin);
  assert.exists(account);
  return account;
}

/**
 * The bundle of `by`'s signature over a Service at `origin` that lists
 * `offers`, each signed by the actor given with it, with all it leads to.
 */
async function signedService(origin: string, offers: readonly (readonly [EncodedObject<Json>, Actor])[], by: Actor) {
  const signed = await Promise.all(offers.map(([object, actor]) => actor.sign(object)));
  const listed = signed.map((signature) => ({ offer: { $link: signature.link }, accept: signature.object }));
  const service = encodeObject(serviceSchemaRead, { origin, at: 1, offers: listed });
  const signature = await by.sign(service);
  const blobs = [
    service.bytes,
    serviceSchemaRead.bytes,
    ...signature.signedIdentity.blobs,
    signatures.schema.bytes,
    ...signed.map(({ bytes }) => bytes),
    ...signed.flatMap(({ signedIdentity }) => signedIdentity.blobs),
    ...offers.flatMap(([object]) => [object.bytes, object.schema.bytes]),
    serviceRoot.bytes,
  ];
  return packBundle(signature, blobs);
}

/** The answer to a posted acceptance with `by`'s signature over an acknowledgement of it, with all it leads to. */
async function acknowledgedBy(by: Actor, request: Request) {
  const acceptance = await unpackBundle(new Uint8Array(await request.arrayBuffer()));
  const acknowledgement = encodeObject(acknowledgementSchemaRead, { accepted: { $link: acceptance.link }, at: 1 });
  const signature = await by.sign(acknowledgement);
  const blobs = [
    acknowledgement.bytes,
    acknowledgementSchemaRead.bytes,
    ...signature.signedIdentity.blobs,
    signatures.schema.bytes,
    acceptance.root,
    ...acceptance.blobs(),
    offer.bytes,
    offerSchema.bytes,
    serviceRoot.bytes,
  ];
  return new Response(await packBundle(signature, blobs), { status: 201 });
}

describe("a service reached at its origin", () => {
  it("is the identity that signed the Service there, which the store keeps", async () => {
    const { origin } = await running({ start: 2_000 });
    const { store, services } = await client();
    const service = await services.at(origin);
    expect(service).toMatchObject({ origin, at: 2_000 });
    expect(service.signedIdentity.identity).toEqual(serviceIdentity(2_000));
    expect(service.account?.service).toBe(service.signedIdentity);
    expect(service.account?.link).toBe(offer.link);
    expect(await mine(store)).toEqual([service.link]);
    expect((await signatures.read(service.link, store, noVersions)).signedIdentity.identity.link).toBe(
      serviceIdentity(2_000).link,
    );
  });

  it.each([
    ["a url with a path", "https://mail.example/inbox"],
    ["plain http to another machine", "http://mail.example"],
    ["not a url", "mail.example"],
  ])("refuses %s as the origin", async (_, origin) => {
    const { services } = await client();
    await expect(services.at(origin)).rejects.toThrow();
  });

  it("refuses a Service that names another origin, and writes nothing", async () => {
    const { service } = await memoryService({ origin: "https://mail.example" });
    const { origin } = await serving((request) => service.fetch(request));
    const { store, services } = await client();
    await expect(services.at(origin)).rejects.toThrow(`the Service at ${origin} names https://mail.example`);
    expect(await mine(store)).toEqual([]);
  });

  it("refuses a Service that lists an offer signed by another root", async () => {
    const { origin } = await serving(
      async (_, origin) =>
        new Response(await signedService(origin, [[offer, await actorOf(mallory)]], await actorOf(serviceSigner))),
    );
    const { services } = await client();
    await expect(services.at(origin)).rejects.toThrow(/lists an offer signed by another root/);
  });

  it("refuses a Service that lists an offer by an agent that the version signing the Service does not list, until the offer is signed again", async () => {
    const [removed, listed] = [signer(ed25519, 7), signer(ed25519, 8)];
    const earlier = signatures.actor(removed, await delegate(serviceSigner, [removed.key], 1_000));
    const later = signatures.actor(listed, await delegate(serviceSigner, [listed.key], 2_000));
    let signedBy = earlier;
    const { origin } = await serving(
      async (_, origin) => new Response(await signedService(origin, [[offer, signedBy]], later)),
    );
    const { store, services } = await client();
    await expect(services.at(origin)).rejects.toThrow(/does not sign for the current version/);
    expect(await mine(store)).toEqual([]);
    signedBy = later;
    const service = await services.at(origin);
    expect(service.account?.link).toBe(offer.link);
    expect((await services.of(service.signedIdentity))?.link).toBe(service.link);
  });

  it("refuses an account offer that names another root than that of the identity that signed it", async () => {
    const zip = async (origin: string) => {
      const actor = await actorOf(mallory);
      return signedService(origin, [[offer, actor]], actor);
    };
    const { origin } = await serving(async (_, origin) => new Response(await zip(origin)));
    const { services } = await client();
    await expect(services.at(origin)).rejects.toThrow(/lists an account offer that names another root/);
  });

  it("passes over an offer of a schema it does not read", async () => {
    const other = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }, defaultValidator);
    const unread = encodeObject(other, { identity: { $link: serviceRoot.link } });
    const actor = await actorOf(serviceSigner);
    const { origin } = await serving(
      async (_, origin) =>
        new Response(
          await signedService(
            origin,
            [
              [unread, actor],
              [offer, actor],
            ],
            actor,
          ),
        ),
    );
    const { services } = await client();
    expect((await services.at(origin)).account?.link).toBe(offer.link);
  });
});

describe("a service found by its root", () => {
  it("is the Service with the latest at that the store holds, whichever came first, read without reaching the service", async () => {
    const first = await running({ start: 1_000 });
    const moved = await running({ start: 5_000 });
    const { services } = await client();
    await services.at(moved.origin);
    const { signedIdentity } = await services.at(first.origin);
    await Promise.all([first.close(), moved.close()]);
    expect(await services.of(signedIdentity)).toMatchObject({ origin: moved.origin, at: 5_000 });
  });

  it("gives the offer of an account that the latest Service lists, taken at its origin", async () => {
    const first = await running();
    const { services } = await client();
    const { signedIdentity } = await services.at(first.origin);
    const moved = await running({ store: first.store, start: 5_000 });
    await services.at(moved.origin);
    await first.close();
    const account = (await services.of(signedIdentity))?.account;
    assert.exists(account);
    expect((await account.accept(await actorOf(alice))).at).toBe(5_001);
  });

  it("is, of two Services at the same at, the one whose signature has the greater link, whichever the store took first", async () => {
    const { origin } = await running();
    const [first, second] = [await client(), await client()];
    const { link, signedIdentity } = await first.services.at(origin);
    await second.services.at(origin);
    const { data } = await readObject(
      first.store,
      (await signatures.read(link, first.store, noVersions)).object,
      serviceSchemaRead,
    );
    const origins = ["https://one.example", "https://two.example"];
    const [greater, lesser] = await signedAtOrigins({ ...data, at: 9_000 }, origins);
    assert.exists(greater);
    assert.exists(lesser);
    for (const { object, signature } of [greater, lesser])
      await first.store.write({ mine: [signature], blobs: [object.bytes] });
    for (const { object, signature } of [lesser, greater])
      await second.store.write({ mine: [signature], blobs: [object.bytes] });
    for (const { services } of [first, second]) {
      expect(await services.of(signedIdentity)).toMatchObject({
        origin: greater.object.data.origin,
        link: greater.signature.link,
      });
    }
  });

  it("is undefined for a root of which the store holds no Service", async () => {
    const { origin } = await running();
    const { services } = await client();
    const { signedIdentity } = await actorOf(serviceSigner);
    expect(await services.of(signedIdentity)).toBeUndefined();
    await services.at(origin);
    expect(await services.of((await actorOf(alice)).signedIdentity)).toBeUndefined();
  });
});

describe("an account offer", () => {
  it("accepted by an identity opens its account, and the store keeps the service's signature over the acknowledgement", async () => {
    const { origin } = await running({ start: 7_000 });
    const { store, services } = await client();
    const service = await services.at(origin);
    assert.exists(service.account);
    const actor = await actorOf(alice);
    const account = await service.account.accept(actor);
    expect(account).toEqual({
      signedIdentity: actor.signedIdentity,
      service: service.signedIdentity,
      at: 7_001,
      link: account.link,
    });
    expect(await mine(store)).toEqual([service.link, account.link].sort());
    const kept = await signatures.read(account.link, store, noVersions);
    expect(kept.signedIdentity.identity.link).toBe(serviceIdentity(7_000).link);
    const { accepted } = (await readObject(store, kept.object, acknowledgementSchemaRead)).data;
    const read = await signatures.read(accepted.$link, store, noVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.link).toBe(account.signedIdentity.link);
  });

  it("accepted by an agent that a Delegated Identity lists opens the account of its root", async () => {
    const { origin } = await running();
    const { services } = await client();
    const actor = await agentOf(laptop, wallet);
    const account = await (await accountAt(services, origin)).accept(actor);
    expect(account.signedIdentity).toBe(actor.signedIdentity);
    expect(account.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
  });

  it("accepted again from another device gets an acknowledgement of that device's acceptance, which its store keeps", async () => {
    const { origin } = await running();
    const signed = await delegate(wallet, [laptop.key, phone.key]);
    const first = await (await accountAt((await client()).services, origin)).accept(signatures.actor(laptop, signed));
    const { store, services } = await client();
    const again = await (await accountAt(services, origin)).accept(signatures.actor(phone, signed));
    expect(again.link).not.toBe(first.link);
    expect(await mine(store)).toContain(again.link);
    const kept = await readObject(
      store,
      (await signatures.read(again.link, store, noVersions)).object,
      acknowledgementSchemaRead,
    );
    const accepted = await signatures.read(kept.data.accepted.$link, store, noVersions);
    expect(accepted.key.link).toBe(keys.encode(phone.key).link);
  });

  it("whose service refuses the acceptance throws what the service said, and writes nothing", async () => {
    const { origin } = await running();
    const { store, services } = await client();
    const service = await services.at(origin);
    assert.exists(service.account);
    const itself = await actorOf(serviceSigner);
    await expect(service.account.accept(itself)).rejects.toThrow(/answered 400: a service opens no account for itself/);
    expect(await mine(store)).toEqual([service.link]);
  });
});

describe("accepting an account offer", () => {
  it("refuses an acknowledgement signed by another root than the service's, and writes nothing", async () => {
    const { origin } = await running({}, async (_, request) => acknowledgedBy(await actorOf(mallory), request));
    const { store, services } = await client();
    const account = await accountAt(services, origin);
    await expect(account.accept(await actorOf(alice))).rejects.toThrow(/signed by another root/);
    expect(await mine(store)).toHaveLength(1);
  });

  it("refuses an acknowledgement by an agent that a later version of the service's, which the store knows, does not list", async () => {
    const [removed, listed] = [signer(ed25519, 7), signer(ed25519, 8)];
    const earlier = signatures.actor(removed, await delegate(serviceSigner, [removed.key], 1_000));
    const later = signatures.actor(listed, await delegate(serviceSigner, [listed.key], 2_000));
    const { origin } = await serving(async (request, origin) =>
      request.method === "POST"
        ? acknowledgedBy(earlier, request)
        : new Response(await signedService(origin, [[offer, later]], later)),
    );
    const { store, services } = await client();
    const account = await accountAt(services, origin);
    await expect(account.accept(await actorOf(alice))).rejects.toThrow(/does not sign for the current version/);
    expect(await mine(store)).toHaveLength(1);
  });

  it("refuses the service's acknowledgement of another acceptance than the one it sent, and writes nothing", async () => {
    const bobs = await (await actorOf(bob)).sign(offer);
    const { origin } = await running({}, async (service, request) =>
      service.fetch(
        new Request(request.url, { method: "POST", body: await packBundle(bobs, bobs.signedIdentity.blobs) }),
      ),
    );
    const { store, services } = await client();
    const account = await accountAt(services, origin);
    await expect(account.accept(await actorOf(alice))).rejects.toThrow(/not the acceptance sent/);
    expect(await mine(store)).toHaveLength(1);
  });
});
