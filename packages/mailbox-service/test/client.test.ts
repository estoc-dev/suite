import { packBundle, unpackBundle } from "@estoc/bundle";
import type { Signer } from "@estoc/identity";
import { encodeObject, type Link, readObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import type { Store } from "@estoc/store";
import { Temporal } from "temporal-polyfill";
import { afterEach, assert, describe, expect, it } from "vitest";
import { loadServices } from "../src/index.ts";
import type { MailboxService } from "../src/server.ts";
import {
  acknowledgementSchemaRead,
  authorizations,
  identities,
  memoryService,
  memoryStore,
  offerSchema,
  serve,
  serviceIdentity,
  signatures,
  signer,
} from "./fixtures.ts";

const alice = signer("ed25519", 1);
const bob = signer("ed25519", 5);
const wallet = signer("eip191", 2);
const laptop = signer("ed25519", 3);
const phone = signer("solana-offchain", 4);
const mallory = signer("ed25519", 6);

const through = async (agent: Signer, principal: Signer, until?: Temporal.Instant) =>
  authorizations.createActor(agent, [await authorizations.authorize(agent.identity, principal, until)]);

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => void (await Promise.all(servers.splice(0).map((server) => server.close()))));

async function running(handle: (request: Request) => Promise<Response>) {
  const server = await serve(handle);
  servers.push(server);
  return server.origin;
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

describe("an offer", () => {
  it("accepted by an identity opens its account, and the store keeps the service's signatures over the offer and the acknowledgement", async () => {
    const { service } = await memoryService({ start: 7_000 });
    const origin = await running((request) => service.fetch(request));
    const { store, services } = await client();
    const offer = await services.offer(origin);
    expect(offer.service.link).toBe(serviceIdentity.link);

    const account = await offer.accept(authorizations.createActor(alice));
    expect(account).toEqual({
      identity: identities.encode(alice.identity),
      service: serviceIdentity,
      at: 7_000,
      link: account.link,
    });
    const kept = await signatures.read(account.link, store);
    expect(kept.identity.link).toBe(serviceIdentity.link);
    const { accepted } = (await readObject(store, kept.object, acknowledgementSchemaRead)).data;
    expect((await authorizations.readStanding(offer.link, accepted.$link, store, new Date(7_000))).principal.link).toBe(
      account.identity.link,
    );
    const signedOffer = (await mine(store)).find((link) => link !== account.link);
    assert.exists(signedOffer);
    const offered = await signatures.read(signedOffer, store);
    expect([offered.object, offered.identity.link]).toEqual([offer.link, serviceIdentity.link]);
  });

  it("accepted through a chain opens the account of the identity that the chain starts at", async () => {
    const { service } = await memoryService();
    const { services } = await client();
    const offer = await services.offer(await running((request) => service.fetch(request)));
    const account = await offer.accept(await through(laptop, wallet));
    expect(account.identity).toEqual(identities.encode(wallet.identity));
  });

  it("accepted again from another device gets the acknowledgement that opened the account, which that device's store then keeps", async () => {
    const { service } = await memoryService();
    const origin = await running((request) => service.fetch(request));
    const first = await (await (await client()).services.offer(origin)).accept(await through(laptop, wallet));
    const { store, services } = await client();
    const again = await (await services.offer(origin)).accept(await through(phone, wallet));
    expect(again).toEqual(first);
    const kept = await readObject(store, (await signatures.read(again.link, store)).object, acknowledgementSchemaRead);
    const standing = await authorizations.readStanding(
      (await services.offer(origin)).link,
      kept.data.accepted.$link,
      store,
      new Date(again.at),
    );
    expect(standing.agents).toEqual([identities.encode(laptop.identity)]);
  });

  it("whose service refuses the acceptance throws what the service said, and writes nothing", async () => {
    const { service } = await memoryService({ start: Date.parse("2026-10-26T12:00:00Z") });
    const { store, services } = await client();
    const offer = await services.offer(await running((request) => service.fetch(request)));
    const ended = await through(laptop, wallet, Temporal.Instant.from("2026-10-26T00:00:00Z"));
    await expect(offer.accept(ended)).rejects.toThrow(/answered 400: the authorization .* ended/);
    expect(await mine(store)).toEqual([]);
  });
});

describe("getting an offer", () => {
  it.each([
    ["a url with a path", "https://mail.example/inbox"],
    ["plain http to another machine", "http://mail.example"],
    ["not a url", "mail.example"],
  ])("refuses %s as the origin", async (_, origin) => {
    const { services } = await client();
    await expect(services.offer(origin)).rejects.toThrow();
  });

  it("refuses an offer signed by another identity than the one it names", async () => {
    const offer = encodeObject(offerSchema, { identity: { $link: serviceIdentity.link } });
    const signature = await signatures.sign(offer, mallory);
    const zip = await packBundle(signature, [offer.bytes, signature.identity.bytes]);
    const origin = await running(async () => new Response(zip));
    const { services } = await client();
    await expect(services.offer(origin)).rejects.toThrow(/signed by another identity/);
  });
});

// A service that hands the offer of `service` and answers an acceptance as `answer` does.
async function answering(service: MailboxService, answer: (zip: Uint8Array) => Promise<Response>) {
  return running(async (request) =>
    request.method === "POST" ? answer(new Uint8Array(await request.arrayBuffer())) : service.fetch(request),
  );
}

describe("accepting an offer", () => {
  it("refuses an acknowledgement signed by another identity than the service's, and writes nothing", async () => {
    const { service } = await memoryService();
    const origin = await answering(service, async (zip) => {
      const acknowledgement = encodeObject(acknowledgementSchemaRead, {
        accepted: { $link: (await unpackBundle(zip)).link },
        at: 1,
      });
      const signature = await signatures.sign(acknowledgement, mallory);
      return new Response(await packBundle(signature, [acknowledgement.bytes, signature.identity.bytes]), {
        status: 201,
      });
    });
    const { store, services } = await client();
    await expect((await services.offer(origin)).accept(authorizations.createActor(alice))).rejects.toThrow(
      /signed by another identity/,
    );
    expect(await mine(store)).toEqual([]);
  });

  it("refuses the service's acknowledgement of another identity's account, and writes nothing", async () => {
    const { service } = await memoryService();
    const offer = (await (await client()).services.offer(await running((request) => service.fetch(request)))).link;
    const bobs = await signatures.sign({ link: offer }, bob);
    const origin = await answering(service, async () =>
      service.fetch(
        new Request("https://mail.example/", { method: "POST", body: await packBundle(bobs, [bobs.identity.bytes]) }),
      ),
    );
    const { store, services } = await client();
    await expect((await services.offer(origin)).accept(authorizations.createActor(alice))).rejects.toThrow(
      /another identity's account/,
    );
    expect(await mine(store)).toEqual([]);
  });
});
