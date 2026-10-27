import { packBundle, unpackBundle } from "@estoc/bundle";
import { encodeObject, type Link, readObject } from "@estoc/object";
import { Temporal } from "temporal-polyfill";
import { assert, describe, expect, it } from "vitest";
import type { MailboxService } from "../src/server.ts";
import {
  acknowledgementSchemaRead,
  authorizations,
  identities,
  memoryService,
  offerSchema,
  serviceIdentity,
  serviceSchemaRead,
  serviceSigner,
  signatures,
  signer,
} from "./fixtures.ts";

const alice = signer("ed25519", 1);
const wallet = signer("eip191", 2);
const device = signer("ed25519", 3);
const otherService = signer("ed25519", 4);

const request = (path: string, init?: RequestInit) => new Request(new URL(path, "https://mail.example"), init);
const getRoot = (service: MailboxService) => service.fetch(request("/"));
const post = (service: MailboxService, id: string, body: Uint8Array) =>
  service.fetch(request(`/${id}`, { method: "POST", body }));
const bundleOf = async (response: Response) => unpackBundle(new Uint8Array(await response.arrayBuffer()));
const mine = async (store: { mine(): AsyncIterable<Link<never>> }) => {
  const links: Link<never>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links.sort();
};

/** What `GET /` answers, read: the service's signature over its Service, and the offer of an account it lists. */
async function rootOf(service: MailboxService) {
  const bundle = await bundleOf(await getRoot(service));
  const signature = await signatures.read(bundle.link, bundle);
  const { data } = await readObject(bundle, signature.object, serviceSchemaRead);
  const [listed] = data.offers;
  assert.exists(listed);
  const offered = await signatures.read(listed.offer.$link, bundle);
  const offer = await readObject(bundle, offered.object, offerSchema);
  return { signature, data, offered, offer, accept: listed.accept };
}

const accepting = async (service: MailboxService, body: Uint8Array) =>
  post(service, (await rootOf(service)).accept, body);

/** The bundle that accepts `offer` by `by`'s own signature, with its identity. */
async function direct(offer: { readonly link: Link<unknown> }, by = alice) {
  const signature = await signatures.sign(offer, by);
  return { signature, zip: await packBundle(signature, [signature.identity.bytes]) };
}

/** The bundle that accepts `offer` for the wallet, through a proxy that the device signs. */
async function proxied(offer: { readonly link: Link<unknown> }, until?: Temporal.Instant) {
  const grant = await authorizations.authorize(device.identity, wallet, until);
  const { signature, blobs } = await authorizations.createActor(device, [grant]).sign(offer.link);
  return { signature, zip: await packBundle(signature, blobs) };
}

async function acknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle);
  return { bundle, signature, acknowledgement: await readObject(bundle, signature.object, acknowledgementSchemaRead) };
}

describe("a mailbox service", () => {
  it("answers GET / with its signature over a Service at its origin, which lists its offer of an account and the id that takes acceptances of it", async () => {
    const { service } = await memoryService({ start: 3_000 });
    const response = await getRoot(service);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const { signature, data, offered, offer, accept } = await rootOf(service);
    expect(signature.identity.link).toBe(serviceIdentity.link);
    expect(data).toEqual({
      origin: "https://mail.example",
      at: 3_000,
      offers: [{ offer: { $link: offered.link }, accept }],
    });
    expect(accept).toMatch(/^[0-9a-f]{32}$/);
    expect(offered.identity.link).toBe(serviceIdentity.link);
    expect(offer.data).toEqual({ identity: { $link: serviceIdentity.link } });
  });

  it("opens an account for the identity that signs its offer, and answers 201 with its signature over an acknowledgement", async () => {
    const { service } = await memoryService({ start: 5_000 });
    const { offer, accept } = await rootOf(service);
    const accepted = await direct(offer);
    const response = await post(service, accept, accepted.zip);
    expect(response.status).toBe(201);
    const { bundle, signature, acknowledgement } = await acknowledgementIn(response);
    expect(signature.identity.link).toBe(serviceIdentity.link);
    expect(acknowledgement.data).toEqual({ accepted: { $link: accepted.signature.link }, at: 5_001 });
    expect(await authorizations.readStanding(offer.link, accepted.signature.link, bundle, new Date(5_001))).toEqual({
      principal: identities.encode(alice.identity),
      agents: [],
    });
  });

  it("answers 200 with the same acknowledgement when the same acceptance comes again", async () => {
    const { service } = await memoryService();
    const { zip } = await direct((await rootOf(service)).offer);
    const first = new Uint8Array(await (await accepting(service, zip)).arrayBuffer());
    const again = await accepting(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
  });

  it("opens the account of the principal for an agent's signature over a proxy", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const accepted = await proxied(offer);
    const response = await accepting(service, accepted.zip);
    expect(response.status).toBe(201);
    const { bundle, acknowledgement } = await acknowledgementIn(response);
    const { accepted: link, at } = acknowledgement.data;
    expect(link.$link).toBe(accepted.signature.link);
    expect(await authorizations.readStanding(offer.link, link.$link, bundle, new Date(at))).toEqual({
      principal: identities.encode(wallet.identity),
      agents: [identities.encode(device.identity)],
    });
  });

  it("answers an identity that accepts again, another way, with the acknowledgement of its first acceptance", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const first = new Uint8Array(await (await accepting(service, (await direct(offer, wallet)).zip)).arrayBuffer());
    const again = await accepting(service, (await proxied(offer)).zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
  });

  it.each<[string, (service: MailboxService) => Promise<Uint8Array>]>([
    ["that is not a zip", async () => new TextEncoder().encode("hello")],
    ["whose root is not a signature", async (service) => packBundle((await rootOf(service)).offer, [])],
    [
      "whose signature comes without its identity",
      async (service) => packBundle((await direct((await rootOf(service)).offer)).signature, []),
    ],
    [
      "accepting another service's offer",
      async () => {
        const { service: other } = await memoryService({ by: otherService });
        return (await direct((await rootOf(other)).offer)).zip;
      },
    ],
    [
      "through an authorization that has ended",
      async (service) =>
        (await proxied((await rootOf(service)).offer, Temporal.Instant.fromEpochMilliseconds(500))).zip,
    ],
    [
      "that is the service's own signature over its offer",
      async (service) => (await direct((await rootOf(service)).offer, serviceSigner)).zip,
    ],
  ])("answers 400 to a bundle %s, and opens no account", async (_, body) => {
    const { service, store } = await memoryService();
    const response = await accepting(service, await body(service));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toBe("");
    expect(await mine(store)).toEqual([(await rootOf(service)).signature.link]);
  });

  it("answers 413 to a body of more than 64 KiB", async () => {
    const { service } = await memoryService();
    expect((await accepting(service, new Uint8Array(64 * 1024 + 1))).status).toBe(413);
  });

  it("answers 404 at an id it did not give out, and at any other path", async () => {
    const { service } = await memoryService();
    const { accept } = await rootOf(service);
    for (const path of [`/${"0".repeat(32)}`, `/${accept.toUpperCase()}`, `/${accept}/`, "/offer", "/accounts"])
      expect((await service.fetch(request(path, { method: "POST", body: "x" }))).status).toBe(404);
  });

  it("answers 405 to another method, saying which it takes", async () => {
    const { service } = await memoryService();
    const put = await service.fetch(request("/", { method: "PUT", body: "x" }));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET");
    const get = await service.fetch(request(`/${(await rootOf(service)).accept}`));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("answers a browser's preflight for posting a zip from another origin", async () => {
    const { service } = await memoryService();
    const response = await service.fetch(request(`/${(await rootOf(service)).accept}`, { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    });
  });

  it("answers 410 at an id that only an earlier Service of its lists", async () => {
    const { service, store } = await memoryService({ start: 3_000 });
    const { offered, offer } = await rootOf(service);
    const id = "f".repeat(32);
    const earlier = encodeObject(serviceSchemaRead, {
      origin: "https://mail.example",
      at: 2_000,
      offers: [{ offer: { $link: offered.link }, accept: id }],
    });
    await store.write({ mine: [await signatures.sign(earlier, serviceSigner)], blobs: [earlier.bytes] });
    expect((await post(service, id, (await direct(offer)).zip)).status).toBe(410);
  });

  it("answers with the latest Service that its store holds, which a start elsewhere may have signed since", async () => {
    const { service, store } = await memoryService();
    await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const { data, accept, offer } = await rootOf(service);
    expect(data).toMatchObject({ origin: "https://post.example", at: 9_000 });
    expect((await post(service, accept, (await direct(offer)).zip)).status).toBe(201);
  });

  it("refuses to start at a url that is not an origin", async () => {
    await expect(memoryService({ origin: "https://mail.example/inbox" })).rejects.toThrow(/is not an origin/);
  });
});

describe("a mailbox service started again", () => {
  it("answers with the same Service when its origin and its offer are as they were", async () => {
    const { service, store } = await memoryService();
    const first = new Uint8Array(await (await getRoot(service)).arrayBuffer());
    const { service: again } = await memoryService({ store, start: 9_000 });
    expect(new Uint8Array(await (await getRoot(again)).arrayBuffer())).toEqual(first);
    expect(await mine(store)).toHaveLength(1);
  });

  it("at another origin signs a new Service, which keeps the signature over its offer and the id that takes acceptances of it", async () => {
    const { service, store } = await memoryService();
    const before = await rootOf(service);
    const { service: moved } = await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const after = await rootOf(moved);
    expect(after.data).toEqual({ ...before.data, origin: "https://post.example", at: 9_000 });
    expect(await mine(store)).toEqual([before.signature.link, after.signature.link].sort());
    expect((await post(moved, after.accept, (await direct(after.offer)).zip)).status).toBe(201);
  });

  it("at another origin signs its new Service later than the one before, though its clock is behind", async () => {
    const { store } = await memoryService({ start: 5_000 });
    const { service: moved } = await memoryService({ store, origin: "https://post.example", start: 1_000 });
    expect((await rootOf(moved)).data).toMatchObject({ origin: "https://post.example", at: 5_001 });
  });
});
