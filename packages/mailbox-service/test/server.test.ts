import { packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  eip191,
  noVersions,
  type Signature,
  type SignedIdentityObject,
  type Signer,
} from "@estoc/identity";
import { decodeObject, encodeObject, encodeSchema, type Link, linkOf, readObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { assert, describe, expect, it, vi } from "vitest";
import type { MailboxService } from "../src/server.ts";
import {
  acknowledgementSchemaRead,
  actorOf,
  delegate,
  identities,
  keys,
  mailboxAcknowledgementSchemaRead,
  mailboxOfferSchemaRead,
  mailboxRequestSchemaRead,
  memoryService,
  memoryStore,
  offerSchema,
  pickupAnswerSchemaRead,
  pickupRequestSchemaRead,
  publish,
  serviceActor,
  serviceIdentity,
  serviceRoot,
  serviceSchemaRead,
  serviceSigner,
  signatures,
  signedAtOrigins,
  signer,
  terms,
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
const records = async (store: { records(): AsyncIterable<Link<never>> }) => {
  const links: Link<never>[] = [];
  for await (const link of store.records()) links.push(link);
  return links.sort();
};

/**
 * What `GET /` answers, read: the service's signature over its Service, the
 * offer of an account it lists, and its offer of mailboxes.
 */
async function rootOf(service: MailboxService) {
  const bundle = await bundleOf(await getRoot(service));
  const signature = await signatures.read(bundle.link, bundle, noVersions);
  const { data } = await readObject(bundle, signature.object, serviceSchemaRead);
  const [listed, listedMailbox] = data.offers;
  assert.exists(listed);
  assert.exists(listedMailbox);
  const offered = await signatures.read(listed.offer.$link, bundle, noVersions);
  const offer = await readObject(bundle, offered.object, offerSchema);
  const mailboxOffered = await signatures.read(listedMailbox.offer.$link, bundle, noVersions);
  const mailbox = {
    offered: mailboxOffered,
    offer: await readObject(bundle, mailboxOffered.object, mailboxOfferSchemaRead),
    acceptId: listedMailbox.acceptId,
  };
  return { signature, data, offered, offer, acceptId: listed.acceptId, mailbox };
}

const accepting = async (service: MailboxService, body: Uint8Array) =>
  post(service, (await rootOf(service)).acceptId, body);

/** The bundle that accepts `offer` by `by`'s own signature, with the blobs of its identity. */
async function directAcceptance(offer: { readonly link: Link<unknown> }, by = alice) {
  const signature = await (await actorOf(by)).sign(offer);
  return { signature, zip: await packBundle(signature, signature.signedIdentity.blobs) };
}

/** The bundle that accepts `offer` for the wallet by the device, which a Delegated Identity of the wallet's lists. */
async function delegatedAcceptance(offer: { readonly link: Link<unknown> }) {
  const signature = await signatures.actor(device, await delegate(wallet, [device.key])).sign(offer);
  return { signature, zip: await packBundle(signature, signature.signedIdentity.blobs) };
}

/** The bundle that accepts `offer` by `agent`, which `version` of the wallet's Delegated Identity lists. */
async function acceptanceBy(agent: Signer, version: SignedIdentityObject, offer: { readonly link: Link<unknown> }) {
  const signature = await signatures.actor(agent, version).sign(offer);
  return packBundle(signature, signature.signedIdentity.blobs);
}

/** A signer as `signer` that, while `isHolding`, holds each signature back until it is released, the first asked first. */
function heldSigner(signer: Signer) {
  const signing: (() => void)[] = [];
  const held = {
    isHolding: false,
    signing,
    signer: {
      key: signer.key,
      async sign(digest: Uint8Array, signedIdentity?: Uint8Array) {
        if (held.isHolding) await new Promise<void>((release) => signing.push(release));
        return signer.sign(digest, signedIdentity);
      },
    },
    release: () => signing.shift()?.(),
  };
  return held;
}

async function acknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle, noVersions);
  return { bundle, signature, acknowledgement: await readObject(bundle, signature.object, acknowledgementSchemaRead) };
}

describe("a mailbox service", () => {
  it("answers GET / with its signature over a Service at its origin, which lists its offers of an account and of mailboxes, each under the offer's link", async () => {
    const { service } = await memoryService({ start: 3_000 });
    const response = await getRoot(service);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const { signature, data, offered, offer, acceptId, mailbox } = await rootOf(service);
    expect(signature.signedIdentity.identity.link).toBe(serviceIdentity(3_000).link);
    expect(data).toEqual({
      origin: "https://mail.example",
      at: 3_000,
      offers: [
        { offer: { $link: offered.link }, acceptId },
        { offer: { $link: mailbox.offered.link }, acceptId: mailbox.acceptId },
      ],
    });
    expect([acceptId, mailbox.acceptId]).toEqual([offer.link, mailbox.offer.link]);
    for (const { signedIdentity } of [offered, mailbox.offered])
      expect(signedIdentity.identity.link).toBe(serviceIdentity(3_000).link);
    expect(offer.data).toEqual({ identity: { $link: serviceRoot.link } });
    expect(mailbox.offer.data).toEqual({ identity: { $link: serviceRoot.link }, ...terms });
  });

  it("opens an account for the identity that signs its offer, and answers 201 with its signature over an acknowledgement", async () => {
    const { service } = await memoryService({ start: 5_000 });
    const { offer, acceptId } = await rootOf(service);
    const acceptance = await directAcceptance(offer);
    const response = await post(service, acceptId, acceptance.zip);
    expect(response.status).toBe(201);
    const { bundle, signature, acknowledgement } = await acknowledgementIn(response);
    expect(signature.signedIdentity.identity.link).toBe(serviceIdentity(5_000).link);
    expect(acknowledgement.data).toEqual({ acceptance: { $link: acceptance.signature.link }, at: 5_001 });
    const read = await signatures.read(acceptance.signature.link, bundle, noVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.identity).toEqual(identities.encode(alice.key, 0));
  });

  it("opens an account for an acceptance that carries only the blobs reading it takes, in a scheme the service does not sign in", async () => {
    const { service } = await memoryService();
    const { signature } = await directAcceptance((await rootOf(service)).offer, wallet);
    const { signedIdentity } = signature;
    const read = [signedIdentity.bytes, signedIdentity.identity.bytes, signedIdentity.identity.root.bytes];
    expect((await accepting(service, await packBundle(signature, read))).status).toBe(201);
  });

  it("answers the same acceptance again with 200 and the acknowledgement it signed for it, and signs no other", async () => {
    const { service, store } = await memoryService();
    const { zip } = await directAcceptance((await rootOf(service)).offer);
    const first = new Uint8Array(await (await accepting(service, zip)).arrayBuffer());
    const opened = await records(store);
    const again = await accepting(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
    expect(await records(store)).toEqual(opened);
  });

  it("opens the account of a root for the signature of an agent that a Delegated Identity of the root's lists", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const acceptance = await delegatedAcceptance(offer);
    const response = await accepting(service, acceptance.zip);
    expect(response.status).toBe(201);
    const { bundle, acknowledgement } = await acknowledgementIn(response);
    const { acceptance: link } = acknowledgement.data;
    expect(link.$link).toBe(acceptance.signature.link);
    const read = await signatures.read(link.$link, bundle, noVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
    expect(read.key.link).toBe(keys.encode(device.key).link);
  });

  it("answers a root that accepts again, by another identity, with 200 and an acknowledgement of that acceptance", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    expect((await accepting(service, (await directAcceptance(offer, wallet)).zip)).status).toBe(201);
    const again = await delegatedAcceptance(offer);
    const response = await accepting(service, again.zip);
    expect(response.status).toBe(200);
    expect((await acknowledgementIn(response)).acknowledgement.data.acceptance.$link).toBe(again.signature.link);
  });

  it("answers 400 to an agent that a later version of its root removed, though the root has an account", async () => {
    const { service, store } = await memoryService();
    const { offer } = await rootOf(service);
    const first = await delegate(wallet, [device.key, phone.key], 1_000);
    const second = await delegate(wallet, [phone.key], 2_000);
    expect((await accepting(service, await acceptanceBy(phone, second, offer))).status).toBe(201);
    const opened = await records(store);
    const response = await accepting(service, await acceptanceBy(device, first, offer));
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not sign for the current version/);
    expect(await records(store)).toEqual(opened);
  });

  it("answers 400 to an agent that a later version removed, though the agent opened the account before it came", async () => {
    const { service, store } = await memoryService();
    const { offer } = await rootOf(service);
    const removed = await acceptanceBy(device, await delegate(wallet, [device.key], 1_000), offer);
    expect((await accepting(service, removed)).status).toBe(201);
    const second = await delegate(wallet, [phone.key], 2_000);
    expect((await accepting(service, await acceptanceBy(phone, second, offer))).status).toBe(200);
    expect((await accepting(service, removed)).status).toBe(400);
    const { service: again } = await memoryService({ store });
    expect((await accepting(again, removed)).status).toBe(400);
  });

  it("answers 400 to an agent whose body comes in only after a later version removed it, and signs nothing for it", async () => {
    const { service, store } = await memoryService();
    const { offer, acceptId } = await rootOf(service);
    const removed = await acceptanceBy(device, await delegate(wallet, [device.key], 1_000), offer);
    let reading = () => {};
    const read = new Promise<void>((resolve) => (reading = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading();
          await released;
          controller.enqueue(removed);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const sending = service.fetch(request(`/${acceptId}`, { method: "POST", body, duplex: "half" } as RequestInit));
    await read;
    const second = await delegate(wallet, [phone.key], 2_000);
    expect((await accepting(service, await acceptanceBy(phone, second, offer))).status).toBe(201);
    const opened = await records(store);
    release();
    const response = await sending;
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not sign for the current version/);
    expect(await records(store)).toEqual(opened);
  });

  it("answers two acceptances that open one account at once with 201 and 200, each acknowledged, and has seen the versions of both", async () => {
    const held = heldSigner(serviceSigner);
    const { service } = await memoryService({ by: held.signer });
    const { offer } = await rootOf(service);
    const earlier = await acceptanceBy(device, await delegate(wallet, [device.key], 1_000), offer);
    const later = await acceptanceBy(wallet, await publish(wallet, 2_000), offer);
    held.isHolding = true;
    const opening = accepting(service, earlier);
    await vi.waitFor(() => expect(held.signing).toHaveLength(1));
    const racing = accepting(service, later);
    await vi.waitFor(() => expect(held.signing).toHaveLength(2));
    held.isHolding = false;
    held.release();
    const opened = await opening;
    held.release();
    const answered = await racing;
    expect([opened.status, answered.status]).toEqual([201, 200]);
    for (const [response, zip] of [
      [opened, earlier],
      [answered, later],
    ] as const) {
      const { acknowledgement } = await acknowledgementIn(response);
      expect(acknowledgement.data.acceptance.$link).toBe((await unpackBundle(zip)).link);
    }
    expect((await accepting(service, earlier)).status).toBe(400);
  });

  it("answers one acceptance posted twice at once with 201 and 200, each acknowledging it, and later with the acknowledgement whose signature has the least link", async () => {
    const held = heldSigner(serviceSigner);
    const { service, store } = await memoryService({ by: held.signer });
    const { signature: acceptance, zip } = await directAcceptance((await rootOf(service)).offer);
    held.isHolding = true;
    const opening = accepting(service, zip);
    await vi.waitFor(() => expect(held.signing).toHaveLength(1));
    const racing = accepting(service, zip);
    await vi.waitFor(() => expect(held.signing).toHaveLength(2));
    held.isHolding = false;
    held.release();
    const opened = await opening;
    held.release();
    const answered = await racing;
    expect([opened.status, answered.status]).toEqual([201, 200]);
    const answers = await Promise.all([opened, answered].map(acknowledgementIn));
    for (const { acknowledgement } of answers) expect(acknowledgement.data.acceptance.$link).toBe(acceptance.link);
    const kept = await records(store);
    const again = await accepting(service, zip);
    expect(again.status).toBe(200);
    const [least] = answers.map(({ signature }) => signature.link).sort();
    expect((await acknowledgementIn(again)).signature.link).toBe(least);
    expect(await records(store)).toEqual(kept);
  });

  it.each<[string, (service: MailboxService) => Promise<Uint8Array>]>([
    ["that is not a zip", async () => new TextEncoder().encode("hello")],
    ["whose root is not a signature", async (service) => packBundle((await rootOf(service)).offer, [])],
    [
      "whose signature comes without its identity",
      async (service) => packBundle((await directAcceptance((await rootOf(service)).offer)).signature, []),
    ],
    [
      "accepting another service's offer",
      async () => {
        const { service: other } = await memoryService({ by: otherService });
        return (await directAcceptance((await rootOf(other)).offer)).zip;
      },
    ],
    [
      "that is the service's own signature over its offer",
      async (service) => (await directAcceptance((await rootOf(service)).offer, serviceSigner)).zip,
    ],
  ])("answers 400 to a bundle %s, and opens no account", async (_, body) => {
    const { service, store } = await memoryService();
    const response = await accepting(service, await body(service));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toBe("");
    expect(await records(store)).toEqual([(await rootOf(service)).signature.link]);
  });

  it("answers 413 to a body of more than 64 KiB", async () => {
    const { service } = await memoryService();
    expect((await accepting(service, new Uint8Array(64 * 1024 + 1))).status).toBe(413);
  });

  it("answers 404 at an id it did not give out, and at any other path", async () => {
    const { service } = await memoryService();
    const { acceptId } = await rootOf(service);
    for (const path of [
      `/sha256:${"0".repeat(64)}`,
      `/${acceptId.toUpperCase()}`,
      `/${acceptId}/`,
      "/offer",
      "/accounts",
    ])
      expect((await service.fetch(request(path, { method: "POST", body: "x" }))).status).toBe(404);
  });

  it("answers 405 to another method, saying which it takes", async () => {
    const { service } = await memoryService();
    const put = await service.fetch(request("/", { method: "PUT", body: "x" }));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET");
    const get = await service.fetch(request(`/${(await rootOf(service)).acceptId}`));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("answers a browser's preflight for posting a zip from another origin", async () => {
    const { service } = await memoryService();
    const response = await service.fetch(request(`/${(await rootOf(service)).acceptId}`, { method: "OPTIONS" }));
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
    const dropped = encodeObject(schema, { identity: { $link: serviceRoot.link } });
    const asService = await serviceActor(3_000);
    const offered = await asService.sign(dropped);
    const earlier = encodeObject(serviceSchemaRead, {
      origin: "https://mail.example",
      at: 2_000,
      offers: [{ offer: { $link: offered.link }, acceptId: dropped.link }],
    });
    const blobs = [earlier.bytes, offered.bytes, dropped.bytes, schema.bytes];
    await store.write({ records: [await asService.sign(earlier)], blobs });
    expect((await post(service, dropped.link, (await directAcceptance(dropped)).zip)).status).toBe(410);
  });

  it("answers with the latest Service that its store holds, which a start elsewhere may have signed since", async () => {
    const { service, store } = await memoryService();
    await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const { data, acceptId, offer } = await rootOf(service);
    expect(data).toMatchObject({ origin: "https://post.example", at: 9_000 });
    expect((await post(service, acceptId, (await directAcceptance(offer)).zip)).status).toBe(201);
  });

  it("answers with the Service whose signature has the greater link, of two at the same at, whichever its store took first", async () => {
    const [first, second] = [await memoryService(), await memoryService()];
    const { data } = await rootOf(first.service);
    const origins = ["https://one.example", "https://two.example"];
    const [greater, lesser] = await signedAtOrigins({ ...data, at: 9_000 }, origins);
    assert.exists(greater);
    assert.exists(lesser);
    for (const { object, signature } of [greater, lesser])
      await first.store.write({ records: [signature], blobs: [object.bytes] });
    for (const { object, signature } of [lesser, greater])
      await second.store.write({ records: [signature], blobs: [object.bytes] });
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
    const signed = await Promise.all((await records(store)).map((link) => signatures.read(link, store, noVersions)));
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
    expect(await records(store)).toHaveLength(1);
  });

  it("at another origin signs a new Service, which keeps the signature over its offer", async () => {
    const { service, store } = await memoryService();
    const before = await rootOf(service);
    const { service: moved } = await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const after = await rootOf(moved);
    expect(after.data).toEqual({ ...before.data, origin: "https://post.example", at: 9_000 });
    expect(await records(store)).toEqual([before.signature.link, after.signature.link].sort());
    expect((await post(moved, after.acceptId, (await directAcceptance(after.offer)).zip)).status).toBe(201);
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
    const signed = await Promise.all((await records(store)).map((link) => signatures.read(link, store, noVersions)));
    const services = await Promise.all(
      signed.map(async ({ object }) => (await readObject(store, object, serviceSchemaRead)).data),
    );
    expect(services).toContainEqual({ ...before.data, origin: "https://post.example", at: 1_000 });
  });
});

const bob = signer(ed25519, 6);
const keyOf = (fill: number) => fill.toString(16).padStart(2, "0").repeat(32);
const ciphertextOf = (fill: number, length = 64) => new Uint8Array(length).fill(fill);

/** The status that `service` answers `actor`'s acceptance of its offer of an account with. */
async function acceptAccount(service: MailboxService, actor: Actor) {
  const signature = await actor.sign((await rootOf(service)).offer);
  return (await accepting(service, await packBundle(signature, signature.signedIdentity.blobs))).status;
}

/** Opens the account of `actor`'s root at `service`, by the actor's acceptance of its offer. */
const openAccount = async (service: MailboxService, actor: Actor) =>
  expect(await acceptAccount(service, actor)).toBe(201);

/** The bundle of `actor`'s request for a mailbox sealed to `key`, by `offer`. */
async function requesting(actor: Actor, offer: { readonly link: Link<unknown> }, key = keyOf(0x11)) {
  const request = encodeObject(mailboxRequestSchemaRead, { offer: { $link: offer.link as Link<never> }, key });
  const signature = await actor.sign(request);
  return { signature, zip: await packBundle(signature, [request.bytes, ...signature.signedIdentity.blobs]) };
}

const askingForMailbox = async (service: MailboxService, body: Uint8Array) =>
  post(service, (await rootOf(service)).mailbox.acceptId, body);

async function mailboxAcknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle, noVersions);
  return {
    bundle,
    signature,
    acknowledgement: await readObject(bundle, signature.object, mailboxAcknowledgementSchemaRead),
  };
}

/**
 * A mailbox sealed to `key` that `actor` opens at `service`, under the
 * account of its root, which is open already: the link of the service's
 * signature over the acknowledgement, and what the acknowledgement says.
 */
async function openMailbox(service: MailboxService, actor: Actor, key = keyOf(0x11)) {
  const { zip } = await requesting(actor, (await rootOf(service)).mailbox.offer, key);
  const response = await askingForMailbox(service, zip);
  expect(response.status).toBe(201);
  const { signature, acknowledgement } = await mailboxAcknowledgementIn(response);
  return { link: signature.link, ...acknowledgement.data };
}

/** The bundle of `actor`'s request to pick up at the mailbox `mailbox` acknowledges, with `receipts` for what it is done with. */
async function pickupRequest(actor: Actor, mailbox: Link<Signature>, receipts: readonly Uint8Array[] = []) {
  const request = encodeObject(pickupRequestSchemaRead, {
    mailbox: { $link: mailbox },
    receipts: receipts.map((ciphertext) => ({ $link: linkOf(ciphertext) })),
  });
  const signature = await actor.sign(request);
  return packBundle(signature, [request.bytes, ...signature.signedIdentity.blobs]);
}

type OpenedMailbox = Awaited<ReturnType<typeof openMailbox>>;

/** What waits at `mailbox` once `receipts` no longer waits, as `actor` picks it up. */
async function queueAt(
  service: MailboxService,
  mailbox: OpenedMailbox,
  actor: Actor,
  receipts: readonly Uint8Array[] = [],
) {
  const response = await post(service, mailbox.pickupId, await pickupRequest(actor, mailbox.link, receipts));
  expect(response.status).toBe(200);
  const bundle = await bundleOf(response);
  return decodeObject(bundle.root, pickupAnswerSchemaRead).data.ciphertexts.map(({ $link }) => {
    const ciphertext = bundle.get($link);
    assert.exists(ciphertext);
    return ciphertext;
  });
}

describe("a mailbox service's offer of mailboxes", () => {
  it("opens a mailbox under the account of the root whose identity signs a request for one, and answers 201 with its signature over an acknowledgement", async () => {
    const { service } = await memoryService({ start: 5_000 });
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { mailbox } = await rootOf(service);
    const { signature, zip } = await requesting(actor, mailbox.offer);
    const response = await askingForMailbox(service, zip);
    expect(response.status).toBe(201);
    const { bundle, signature: signed, acknowledgement } = await mailboxAcknowledgementIn(response);
    expect(signed.signedIdentity.identity.link).toBe(serviceIdentity(5_000).link);
    const { sendId, pickupId } = acknowledgement.data;
    expect(acknowledgement.data).toEqual({ request: { $link: signature.link }, at: 5_002, sendId, pickupId });
    expect(sendId).toMatch(/^[0-9a-f]{32}$/);
    expect(pickupId).toMatch(/^[0-9a-f]{32}$/);
    expect(sendId).not.toBe(pickupId);
    const read = await signatures.read(signature.link, bundle, noVersions);
    const request = await readObject(bundle, read.object, mailboxRequestSchemaRead);
    expect(request.data).toEqual({ offer: { $link: mailbox.offer.link }, key: keyOf(0x11) });
    expect((await readObject(bundle, request.data.offer.$link, mailboxOfferSchemaRead)).data).toEqual(
      mailbox.offer.data,
    );
  });

  it("opens a mailbox for an agent that a Delegated Identity of the root lists, under the account its wallet opened", async () => {
    const { service } = await memoryService();
    await openAccount(service, await actorOf(wallet));
    const agent = signatures.actor(device, await delegate(wallet, [device.key]));
    const { zip } = await requesting(agent, (await rootOf(service)).mailbox.offer);
    expect((await askingForMailbox(service, zip)).status).toBe(201);
  });

  it("opens a mailbox of its own for each key that one account asks for one", async () => {
    const { service } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const [first, second] = [await openMailbox(service, actor, keyOf(1)), await openMailbox(service, actor, keyOf(2))];
    expect(new Set([first.sendId, first.pickupId, second.sendId, second.pickupId]).size).toBe(4);
  });

  it("answers the same request again with 200 and the acknowledgement it signed for it, and signs no other", async () => {
    const { service, store } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { zip } = await requesting(actor, (await rootOf(service)).mailbox.offer);
    const first = new Uint8Array(await (await askingForMailbox(service, zip)).arrayBuffer());
    const opened = await records(store);
    const again = await askingForMailbox(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
    expect(await records(store)).toEqual(opened);
  });

  it("answers one request posted twice at once with 201 and 200, each with the acknowledgement of the mailbox it opened", async () => {
    const held = heldSigner(serviceSigner);
    const { service } = await memoryService({ by: held.signer });
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { zip } = await requesting(actor, (await rootOf(service)).mailbox.offer);
    held.isHolding = true;
    const opening = askingForMailbox(service, zip);
    await vi.waitFor(() => expect(held.signing).toHaveLength(1));
    const racing = askingForMailbox(service, zip);
    await vi.waitFor(() => expect(held.signing).toHaveLength(2));
    held.isHolding = false;
    held.release();
    const opened = await opening;
    held.release();
    const answered = await racing;
    expect([opened.status, answered.status]).toEqual([201, 200]);
    const [first, second] = await Promise.all([opened, answered].map(mailboxAcknowledgementIn));
    expect(second?.signature.link).toBe(first?.signature.link);
    expect((await mailboxAcknowledgementIn(await askingForMailbox(service, zip))).signature.link).toBe(
      first?.signature.link,
    );
  });

  it("answers 403 to a request by a root that has no account, and opens no mailbox", async () => {
    const { service, store } = await memoryService();
    const { zip } = await requesting(await actorOf(alice), (await rootOf(service)).mailbox.offer);
    const response = await askingForMailbox(service, zip);
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/has no account here/);
    expect(await records(store)).toEqual([(await rootOf(service)).signature.link]);
  });

  it("answers 400 to a request by an agent that a later version of its root removed, though the root has an account", async () => {
    const { service } = await memoryService();
    const { mailbox } = await rootOf(service);
    const removed = signatures.actor(device, await delegate(wallet, [device.key], 1_000));
    await openAccount(service, removed);
    expect(await acceptAccount(service, signatures.actor(phone, await delegate(wallet, [phone.key], 2_000)))).toBe(200);
    const response = await askingForMailbox(service, (await requesting(removed, mailbox.offer)).zip);
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not sign for the current version/);
  });

  it.each<[string, (service: MailboxService, actor: Actor) => Promise<Uint8Array>]>([
    [
      "for the offer of an account",
      async (service, actor) => (await requesting(actor, (await rootOf(service)).offer)).zip,
    ],
    [
      "for another service's offer of mailboxes",
      async (_, actor) => {
        const { service: other } = await memoryService({ by: otherService });
        return (await requesting(actor, (await rootOf(other)).mailbox.offer)).zip;
      },
    ],
    [
      "that is an acceptance of the offer of mailboxes",
      async (service, actor) => {
        const signature = await actor.sign((await rootOf(service)).mailbox.offer);
        return packBundle(signature, signature.signedIdentity.blobs);
      },
    ],
  ])("answers 400 to a request %s, and opens no mailbox", async (_, body) => {
    const { service, store } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const opened = await records(store);
    const response = await askingForMailbox(service, await body(service, actor));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toBe("");
    expect(await records(store)).toEqual(opened);
  });

  it("keeps the mailboxes it opened on the terms of their offer once it offers other terms", async () => {
    const { service, store, accounts, mailboxes } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const before = await rootOf(service);
    const mailbox = await openMailbox(service, actor);
    const offered = { ...terms, size: 100 };
    const { service: again } = await memoryService({ store, accounts, mailboxes, offered, start: 9_000 });
    const after = await rootOf(again);
    expect(after.mailbox.offer.data.size).toBe(100);
    expect(after.offered.link).toBe(before.offered.link);
    expect((await post(again, mailbox.sendId, ciphertextOf(1, 1_000))).status).toBe(204);
    expect(
      (await post(again, before.mailbox.acceptId, (await requesting(actor, before.mailbox.offer)).zip)).status,
    ).toBe(410);
  });

  it("opens a mailbox on the terms of the offer that the latest Service lists, though another start on its store signed it", async () => {
    const { service, ...shared } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { service: newer } = await memoryService({ ...shared, offered: { ...terms, size: 100 }, start: 9_000 });
    expect((await rootOf(service)).mailbox.offer.data.size).toBe(100);
    const mailbox = await openMailbox(service, actor);
    expect((await post(newer, mailbox.sendId, ciphertextOf(1, 101))).status).toBe(413);
    expect((await post(service, mailbox.sendId, ciphertextOf(1, 100))).status).toBe(204);
  });

  it("started again with its clock behind takes requests for the offer that the latest Service lists, and answers 410 at its own", async () => {
    const { service, ...shared } = await memoryService({ start: 5_000 });
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { zip } = await requesting(actor, (await rootOf(service)).mailbox.offer);
    const first = new Uint8Array(await (await askingForMailbox(service, zip)).arrayBuffer());
    const offered = { ...terms, size: 100 };
    const { service: behind } = await memoryService({ ...shared, offered, start: 1_000 });
    const again = await askingForMailbox(behind, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
    const opened = await openMailbox(behind, actor, keyOf(0x22));
    expect((await post(behind, opened.sendId, ciphertextOf(1, 1_000))).status).toBe(204);
    const own = encodeObject(mailboxOfferSchemaRead, { identity: { $link: serviceRoot.link }, ...offered });
    expect((await post(behind, own.link, (await requesting(actor, own)).zip)).status).toBe(410);
  });
});

describe("a mailbox that a service opened", () => {
  async function serviceWithMailbox(options: Parameters<typeof memoryService>[0] = {}) {
    const loaded = await memoryService(options);
    const actor = await actorOf(alice);
    await openAccount(loaded.service, actor);
    return { ...loaded, actor, mailbox: await openMailbox(loaded.service, actor) };
  }

  it("keeps a ciphertext posted to its send id, answering 204, which waits until a pickup has a receipt for it", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    const [first, second] = [ciphertextOf(1), ciphertextOf(2)];
    for (const ciphertext of [first, second])
      expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    expect(await queueAt(service, mailbox, actor)).toEqual([first, second]);
    expect(await queueAt(service, mailbox, actor, [first])).toEqual([second]);
    expect(await queueAt(service, mailbox, actor)).toEqual([second]);
    expect(await queueAt(service, mailbox, actor, [second])).toEqual([]);
  });

  it("keeps a ciphertext that arrives twice once, and takes it again when what waits is at its quota", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    const full = [1, 2, 3, 4].map((fill) => ciphertextOf(fill, terms.quota / 4));
    for (const ciphertext of [...full, ...full])
      expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    expect(await queueAt(service, mailbox, actor)).toEqual(full);
  });

  it("answers 413 to a ciphertext over the size its offer names, and keeps nothing of it", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    expect((await post(service, mailbox.sendId, ciphertextOf(1, terms.size))).status).toBe(204);
    expect((await post(service, mailbox.sendId, ciphertextOf(2, terms.size + 1))).status).toBe(413);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(1, terms.size)]);
  });

  it("answers 429 once what waits would come to more than its quota, and takes ciphertexts again once a pickup has receipts for some", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    const full = [1, 2, 3, 4].map((fill) => ciphertextOf(fill, terms.quota / 4));
    for (const ciphertext of full) expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    const over = await post(service, mailbox.sendId, ciphertextOf(5));
    expect(over.status).toBe(429);
    expect(await over.text()).toMatch(/holds at most 4096 bytes/);
    await queueAt(service, mailbox, actor, full.slice(0, 1));
    expect((await post(service, mailbox.sendId, ciphertextOf(5))).status).toBe(204);
  });

  it("lets what waited longer than the retention its offer names wait no more", async () => {
    const clock = { now: 1_000 };
    const { service, actor, mailbox } = await serviceWithMailbox({ clock });
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    clock.now += terms.retention;
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(1)]);
    clock.now += 1;
    expect(await queueAt(service, mailbox, actor)).toEqual([]);
  });

  it("does not count what waited longer than the retention its offer names toward its quota", async () => {
    const clock = { now: 1_000 };
    const { service, actor, mailbox } = await serviceWithMailbox({ clock });
    const full = [1, 2, 3, 4].map((fill) => ciphertextOf(fill, terms.quota / 4));
    for (const ciphertext of full) expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    clock.now += terms.retention;
    expect((await post(service, mailbox.sendId, ciphertextOf(5))).status).toBe(429);
    clock.now += 1;
    expect((await post(service, mailbox.sendId, ciphertextOf(5))).status).toBe(204);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(5)]);
  });

  it("answers a pickup with 100 ciphertexts at most, the earliest first", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox({ offered: { ...terms, size: 2, quota: 2 * 101 } });
    const sent = Array.from({ length: 101 }, (_, n) => new Uint8Array([n >> 8, n & 0xff]));
    for (const ciphertext of sent) expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    const first = await queueAt(service, mailbox, actor);
    expect(first).toEqual(sent.slice(0, 100));
    expect(await queueAt(service, mailbox, actor, sent.slice(0, 100))).toEqual(sent.slice(100));
  });

  it("answers a pickup with ciphertexts that come to 1 MiB at most, but with the earliest alone when it is larger", async () => {
    const KiB = 1024;
    const { service, actor, mailbox } = await serviceWithMailbox({
      offered: { ...terms, size: 1_536 * KiB, quota: 4_096 * KiB },
    });
    const [a, b, c, d] = [
      ciphertextOf(1, 600 * KiB),
      ciphertextOf(2, 300 * KiB),
      ciphertextOf(3, 200 * KiB),
      ciphertextOf(4, 1_536 * KiB),
    ];
    for (const ciphertext of [a, b, c, d]) expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    // Compared by link, since a difference between bytes this large takes long to print.
    const linksAt = async (receipts: readonly Uint8Array[]) =>
      (await queueAt(service, mailbox, actor, receipts)).map((ciphertext) => linkOf(ciphertext));
    expect(await linksAt([])).toEqual([linkOf(a), linkOf(b)]);
    expect(await linksAt([a, b])).toEqual([linkOf(c)]);
    expect(await linksAt([c])).toEqual([linkOf(d)]);
  });

  it("answers a pickup by an agent that a version of the root lists which it has not seen, by the version that the request carries", async () => {
    const { service, mailbox } = await serviceWithMailbox();
    const listed = signatures.actor(phone, await delegate(alice, [phone.key], 2_000));
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    expect(await queueAt(service, mailbox, listed)).toEqual([ciphertextOf(1)]);
  });

  it("answers 403 to a pickup signed for another root, and is done with nothing", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    const other = await actorOf(bob);
    await openAccount(service, other);
    const response = await post(service, mailbox.pickupId, await pickupRequest(other, mailbox.link, [ciphertextOf(1)]));
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/another root/);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(1)]);
  });

  it("answers 403 to a pickup by an agent that a later version of the root, which it has seen, takes out", async () => {
    const { service } = await memoryService();
    const removed = signatures.actor(device, await delegate(wallet, [device.key], 1_000));
    await openAccount(service, removed);
    const mailbox = await openMailbox(service, removed);
    const listed = signatures.actor(phone, await delegate(wallet, [phone.key], 2_000));
    expect(await acceptAccount(service, listed)).toBe(200);
    const response = await post(service, mailbox.pickupId, await pickupRequest(removed, mailbox.link));
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/does not sign for the current version/);
    expect(await queueAt(service, mailbox, listed)).toEqual([]);
  });

  it.each<[string, (actor: Actor, mailbox: OpenedMailbox, other: OpenedMailbox) => Promise<Uint8Array>]>([
    ["that names another mailbox", (actor, _, other) => pickupRequest(actor, other.link)],
    [
      "that is not a pickup request",
      async (actor, mailbox) => {
        const signature = await actor.sign({ link: mailbox.link });
        return packBundle(signature, signature.signedIdentity.blobs);
      },
    ],
    ["that is not a zip", async () => new TextEncoder().encode("hello")],
  ])("answers 400 to a body %s, and is done with nothing", async (_, body) => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    const other = await openMailbox(service, actor, keyOf(0x22));
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    expect((await post(service, mailbox.pickupId, await body(actor, mailbox, other))).status).toBe(400);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(1)]);
  });

  it("answers 404 at a mailbox id it did not make up", async () => {
    const { service } = await serviceWithMailbox();
    expect((await post(service, "0".repeat(32), ciphertextOf(1))).status).toBe(404);
  });

  it("answers a browser's preflight for posting a ciphertext to its send id from another origin", async () => {
    const { service, mailbox } = await serviceWithMailbox();
    const response = await service.fetch(request(`/${mailbox.sendId}`, { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    });
  });
});
