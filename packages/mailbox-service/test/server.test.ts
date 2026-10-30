import { packBundle, unpackBundle } from "@estoc/bundle";
import { ed25519, eip191, noVersions, type SignedIdentityObject, type Signer } from "@estoc/identity";
import { encodeObject, encodeSchema, type Link, readObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { assert, describe, expect, it, vi } from "vitest";
import type { MailboxService } from "../src/server.ts";
import {
  acknowledgementSchemaRead,
  actorOf,
  delegate,
  identities,
  keys,
  memoryService,
  memoryStore,
  offerSchema,
  serviceIdentity,
  serviceSchemaRead,
  serviceSigner,
  signatures,
  signedAtOrigins,
  signer,
} from "./fixtures.ts";

const alice = signer(ed25519, 1);
const wallet = signer(eip191, 2);
const device = signer(ed25519, 3);
const phone = signer(ed25519, 5);
const otherService = signer(ed25519, 4);

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
  const signature = await signatures.read(bundle.link, bundle, noVersions);
  const { data } = await readObject(bundle, signature.object, serviceSchemaRead);
  const [listed] = data.offers;
  assert.exists(listed);
  const offered = await signatures.read(listed.offer.$link, bundle, noVersions);
  const offer = await readObject(bundle, offered.object, offerSchema);
  return { signature, data, offered, offer, accept: listed.accept };
}

const accepting = async (service: MailboxService, body: Uint8Array) =>
  post(service, (await rootOf(service)).accept, body);

/** The bundle that accepts `offer` by `by`'s own signature, with the blobs of its identity. */
async function direct(offer: { readonly link: Link<unknown> }, by = alice) {
  const signature = await (await actorOf(by)).sign(offer);
  return { signature, zip: await packBundle(signature, signature.signedIdentity.blobs) };
}

/** The bundle that accepts `offer` for the wallet by the device, which a Delegated Identity of the wallet's lists. */
async function delegated(offer: { readonly link: Link<unknown> }) {
  const signature = await signatures.actor(device, await delegate(wallet, [device.key])).sign(offer);
  return { signature, zip: await packBundle(signature, signature.signedIdentity.blobs) };
}

/** The bundle that accepts `offer` by `agent`, which `version` of the wallet's Delegated Identity lists. */
async function acceptedBy(agent: Signer, version: SignedIdentityObject, offer: { readonly link: Link<unknown> }) {
  const signature = await signatures.actor(agent, version).sign(offer);
  return packBundle(signature, signature.signedIdentity.blobs);
}

async function acknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle, noVersions);
  return { bundle, signature, acknowledgement: await readObject(bundle, signature.object, acknowledgementSchemaRead) };
}

describe("a mailbox service", () => {
  it("answers GET / with its signature over a Service at its origin, which lists its offer of an account under the offer's link", async () => {
    const { service } = await memoryService({ start: 3_000 });
    const response = await getRoot(service);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const { signature, data, offered, offer, accept } = await rootOf(service);
    expect(signature.signedIdentity.identity.link).toBe(serviceIdentity.link);
    expect(data).toEqual({
      origin: "https://mail.example",
      at: 3_000,
      offers: [{ offer: { $link: offered.link }, accept }],
    });
    expect(accept).toBe(offer.link);
    expect(offered.signedIdentity.identity.link).toBe(serviceIdentity.link);
    expect(offer.data).toEqual({ identity: { $link: serviceIdentity.root.link } });
  });

  it("opens an account for the identity that signs its offer, and answers 201 with its signature over an acknowledgement", async () => {
    const { service } = await memoryService({ start: 5_000 });
    const { offer, accept } = await rootOf(service);
    const accepted = await direct(offer);
    const response = await post(service, accept, accepted.zip);
    expect(response.status).toBe(201);
    const { bundle, signature, acknowledgement } = await acknowledgementIn(response);
    expect(signature.signedIdentity.identity.link).toBe(serviceIdentity.link);
    expect(acknowledgement.data).toEqual({ accepted: { $link: accepted.signature.link }, at: 5_001 });
    const read = await signatures.read(accepted.signature.link, bundle, noVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.identity).toEqual(identities.encode(alice.key));
  });

  it("opens an account for an acceptance that carries only the blobs reading it takes, in a scheme the service does not sign in", async () => {
    const { service } = await memoryService();
    const { signature } = await direct((await rootOf(service)).offer, wallet);
    const { signedIdentity } = signature;
    const read = [signedIdentity.bytes, signedIdentity.identity.bytes, signedIdentity.identity.root.bytes];
    expect((await accepting(service, await packBundle(signature, read))).status).toBe(201);
  });

  it("answers 200 with the same acknowledgement when the same acceptance comes again", async () => {
    const { service } = await memoryService();
    const { zip } = await direct((await rootOf(service)).offer);
    const first = new Uint8Array(await (await accepting(service, zip)).arrayBuffer());
    const again = await accepting(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
  });

  it("opens the account of a root for the signature of an agent that a Delegated Identity of the root's lists", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const accepted = await delegated(offer);
    const response = await accepting(service, accepted.zip);
    expect(response.status).toBe(201);
    const { bundle, acknowledgement } = await acknowledgementIn(response);
    const { accepted: link } = acknowledgement.data;
    expect(link.$link).toBe(accepted.signature.link);
    const read = await signatures.read(link.$link, bundle, noVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
    expect(read.key.link).toBe(keys.encode(device.key).link);
  });

  it("answers a root that accepts again, by another identity, with the acknowledgement of its first acceptance", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const first = new Uint8Array(await (await accepting(service, (await direct(offer, wallet)).zip)).arrayBuffer());
    const again = await accepting(service, (await delegated(offer)).zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
  });

  it("answers 400 to an agent that a later version of its root removed, though the root has an account", async () => {
    const { service, store } = await memoryService();
    const { offer } = await rootOf(service);
    const first = await delegate(wallet, [device.key, phone.key], 1_000);
    const second = await delegate(wallet, [phone.key], 2_000);
    expect((await accepting(service, await acceptedBy(phone, second, offer))).status).toBe(201);
    const opened = await mine(store);
    const response = await accepting(service, await acceptedBy(device, first, offer));
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/is not an agent of the current version/);
    expect(await mine(store)).toEqual(opened);
  });

  it("answers an agent that signs by a later version than the service knows with the acknowledgement of the root's account", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const first = await delegate(wallet, [device.key], 1_000);
    const opened = await accepting(service, await acceptedBy(device, first, offer));
    const bytes = new Uint8Array(await opened.arrayBuffer());
    const second = await delegate(wallet, [device.key, phone.key], 2_000);
    const again = await accepting(service, await acceptedBy(phone, second, offer));
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
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
    for (const path of [`/sha256:${"0".repeat(64)}`, `/${accept.toUpperCase()}`, `/${accept}/`, "/offer", "/accounts"])
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

  it("answers 410 at the id of an offer that only an earlier Service of its lists", async () => {
    const { service, store } = await memoryService({ start: 3_000 });
    const schema = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }, defaultValidator);
    const dropped = encodeObject(schema, { identity: { $link: serviceIdentity.root.link } });
    const asService = await actorOf(serviceSigner);
    const offered = await asService.sign(dropped);
    const earlier = encodeObject(serviceSchemaRead, {
      origin: "https://mail.example",
      at: 2_000,
      offers: [{ offer: { $link: offered.link }, accept: dropped.link }],
    });
    const blobs = [earlier.bytes, offered.bytes, dropped.bytes, schema.bytes];
    await store.write({ mine: [await asService.sign(earlier)], blobs });
    expect((await post(service, dropped.link, (await direct(dropped)).zip)).status).toBe(410);
  });

  it("answers with the latest Service that its store holds, which a start elsewhere may have signed since", async () => {
    const { service, store } = await memoryService();
    await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const { data, accept, offer } = await rootOf(service);
    expect(data).toMatchObject({ origin: "https://post.example", at: 9_000 });
    expect((await post(service, accept, (await direct(offer)).zip)).status).toBe(201);
  });

  it("answers with the Service whose signature has the greater link, of two at the same at, whichever its store took first", async () => {
    const [first, second] = [await memoryService(), await memoryService()];
    const { data } = await rootOf(first.service);
    const origins = ["https://one.example", "https://two.example"];
    const [greater, lesser] = await signedAtOrigins({ ...data, at: 9_000 }, origins);
    assert.exists(greater);
    assert.exists(lesser);
    for (const { object, signature } of [greater, lesser])
      await first.store.write({ mine: [signature], blobs: [object.bytes] });
    for (const { object, signature } of [lesser, greater])
      await second.store.write({ mine: [signature], blobs: [object.bytes] });
    for (const { service } of [first, second])
      expect((await rootOf(service)).signature.link).toBe(greater.signature.link);
  });

  it("answers alike from two starts at once on one store, at two origins, though both sign the same at", async () => {
    // Each start signs only once both have read the store, as starts can
    // whose signer answers over a network.
    let release = () => {};
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    let reading = 2;
    const by: Signer = {
      key: serviceSigner.key,
      async sign(digest, signedIdentity) {
        if (--reading === 0) release();
        await bothRead;
        return serviceSigner.sign(digest, signedIdentity);
      },
    };
    const store = memoryStore();
    const started = await Promise.all(
      ["https://one.example", "https://two.example"].map((origin) =>
        memoryService({ store, by, origin, start: 10_000 }),
      ),
    );
    const signed = await Promise.all((await mine(store)).map((link) => signatures.read(link, store, noVersions)));
    const ats = await Promise.all(
      signed.map(async ({ object }) => (await readObject(store, object, serviceSchemaRead)).data.at),
    );
    expect(ats).toEqual([10_000, 10_000]);
    const [one, two] = await Promise.all(started.map(({ service }) => rootOf(service)));
    expect(one?.signature.link).toBe(two?.signature.link);
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

  it("at another origin signs a new Service, which keeps the signature over its offer", async () => {
    const { service, store } = await memoryService();
    const before = await rootOf(service);
    const { service: moved } = await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const after = await rootOf(moved);
    expect(after.data).toEqual({ ...before.data, origin: "https://post.example", at: 9_000 });
    expect(await mine(store)).toEqual([before.signature.link, after.signature.link].sort());
    expect((await post(moved, after.accept, (await direct(after.offer)).zip)).status).toBe(201);
  });

  it("signs as the signed identity of its latest Service, which its signer does not sign again", async () => {
    const { service, store } = await memoryService();
    const before = await rootOf(service);
    const sign = vi.fn((digest: Uint8Array, signedIdentity?: Uint8Array) => serviceSigner.sign(digest, signedIdentity));
    const by = { key: serviceSigner.key, sign };
    const { service: moved } = await memoryService({ store, by, origin: "https://post.example", start: 9_000 });
    const after = await rootOf(moved);
    expect(after.data.origin).toBe("https://post.example");
    expect(after.signature.signedIdentity.link).toBe(before.signature.signedIdentity.link);
    expect(sign).toHaveBeenCalledOnce();
  });

  it("at another origin with its clock behind signs a Service earlier than the one before, which stays the latest", async () => {
    const { service, store } = await memoryService({ start: 5_000 });
    const before = await rootOf(service);
    const { service: moved } = await memoryService({ store, origin: "https://post.example", start: 1_000 });
    expect((await rootOf(moved)).data).toEqual(before.data);
    const signed = await Promise.all((await mine(store)).map((link) => signatures.read(link, store, noVersions)));
    const services = await Promise.all(
      signed.map(async ({ object }) => (await readObject(store, object, serviceSchemaRead)).data),
    );
    expect(services).toContainEqual({ ...before.data, origin: "https://post.example", at: 1_000 });
  });
});
