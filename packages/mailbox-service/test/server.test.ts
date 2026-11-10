import { packBundle, unpackBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  eip191,
  noIdentityVersions,
  type SignedIdentityObject,
  type Signer,
} from "@estoc/identity";
import { decodeObject, encodeObject, encodeSchema, json, type Link, linkOf, readObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Store, view } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { peopleView } from "../src/people.ts";
import type { MailboxService } from "../src/server.ts";
import { SqliteAccounts, SqliteMailboxes } from "../src/sqlite.ts";
import {
  acknowledgementSchemaRead,
  actorOf,
  identities,
  identityVersions,
  keys,
  mailboxAcknowledgementSchemaRead,
  mailboxOfferSchemaRead,
  mailboxRequestSchemaRead,
  makeTemporaryPath,
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
  const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
  const { data } = await readObject(bundle, signature.object, serviceSchemaRead);
  const [listedAccount, listedMailbox] = data.offers;
  assert.exists(listedAccount);
  assert.exists(listedMailbox);
  const offerSignature = await signatures.read(listedAccount.offer.$link, bundle, noIdentityVersions);
  const offer = await readObject(bundle, offerSignature.object, offerSchema);
  const mailboxOfferSignature = await signatures.read(listedMailbox.offer.$link, bundle, noIdentityVersions);
  const mailbox = {
    offerSignature: mailboxOfferSignature,
    offer: await readObject(bundle, mailboxOfferSignature.object, mailboxOfferSchemaRead),
    acceptId: listedMailbox.acceptId,
  };
  return { signature, data, offerSignature, offer, acceptId: listedAccount.acceptId, mailbox };
}

const postAcceptance = async (service: MailboxService, body: Uint8Array) =>
  post(service, (await rootOf(service)).acceptId, body);

/** The bundle that accepts `offer` by `by`'s own signature, with the blobs of its identity. */
async function directAcceptance(offer: { readonly link: Link<unknown> }, by = alice) {
  const signature = await (await actorOf(by)).sign(offer);
  return { signature, zip: await packBundle(signature, signature.signedIdentity.blobs) };
}

/** The bundle that accepts `offer` for the wallet by the device, which an identity of the wallet's lists. */
async function delegatedAcceptance(offer: { readonly link: Link<unknown> }) {
  const signature = await signatures.actor(device, await publish(wallet, { agents: [device.key] })).sign(offer);
  return { signature, zip: await packBundle(signature, signature.signedIdentity.blobs) };
}

/** The bundle that accepts `offer` by `agent`, which `identityVersion` of the wallet lists. */
async function acceptanceBy(
  agent: Signer,
  identityVersion: SignedIdentityObject,
  offer: { readonly link: Link<unknown> },
) {
  const signature = await signatures.actor(agent, identityVersion).sign(offer);
  return packBundle(signature, signature.signedIdentity.blobs);
}

/** A signer as `signer` that, while `isHolding`, holds each signature back until it is released, the first asked first. */
function heldSigner(signer: Signer) {
  const pending: (() => void)[] = [];
  const holder = {
    isHolding: false,
    pending,
    signer: {
      key: signer.key,
      async sign(digest: Uint8Array, signedIdentity?: Uint8Array) {
        if (holder.isHolding) await new Promise<void>((release) => pending.push(release));
        return signer.sign(digest, signedIdentity);
      },
    },
    release: () => pending.shift()?.(),
  };
  return holder;
}

async function acknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
  return { bundle, signature, acknowledgement: await readObject(bundle, signature.object, acknowledgementSchemaRead) };
}

describe("a mailbox service", () => {
  it("answers GET / with its signature over a Service at its origin, which lists its offers of an account and of mailboxes, each under the offer's link", async () => {
    const { service } = await memoryService({ start: 3_000 });
    const response = await getRoot(service);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const { signature, data, offerSignature, offer, acceptId, mailbox } = await rootOf(service);
    expect(signature.signedIdentity.identity.link).toBe(serviceIdentity(3_000).link);
    expect(data).toEqual({
      origin: "https://mail.example",
      at: 3_000,
      offers: [
        { offer: { $link: offerSignature.link }, acceptId },
        { offer: { $link: mailbox.offerSignature.link }, acceptId: mailbox.acceptId },
      ],
    });
    expect([acceptId, mailbox.acceptId]).toEqual([offer.link, mailbox.offer.link]);
    for (const { signedIdentity } of [offerSignature, mailbox.offerSignature])
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
    const read = await signatures.read(acceptance.signature.link, bundle, noIdentityVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.identity).toEqual(identities.encode(alice.key, { at: 0 }));
  });

  it("opens an account for an acceptance that carries only the blobs reading it takes, in a scheme the service does not sign in", async () => {
    const { service } = await memoryService();
    const { signature } = await directAcceptance((await rootOf(service)).offer, wallet);
    const { signedIdentity } = signature;
    const read = [signedIdentity.bytes, ...signedIdentity.identity.blobs];
    expect((await postAcceptance(service, await packBundle(signature, read))).status).toBe(201);
  });

  it("answers the same acceptance again with 200 and the acknowledgement it signed for it, and signs no other", async () => {
    const { service, store } = await memoryService();
    const { zip } = await directAcceptance((await rootOf(service)).offer);
    const first = new Uint8Array(await (await postAcceptance(service, zip)).arrayBuffer());
    const recordsBefore = await records(store);
    const again = await postAcceptance(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
    expect(await records(store)).toEqual(recordsBefore);
  });

  it("opens the account of a root for the signature of an agent that an identity of the root's lists", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    const acceptance = await delegatedAcceptance(offer);
    const response = await postAcceptance(service, acceptance.zip);
    expect(response.status).toBe(201);
    const { bundle, acknowledgement } = await acknowledgementIn(response);
    const { acceptance: link } = acknowledgement.data;
    expect(link.$link).toBe(acceptance.signature.link);
    const read = await signatures.read(link.$link, bundle, noIdentityVersions);
    expect(read.object).toBe(offer.link);
    expect(read.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
    expect(read.key.link).toBe(keys.encode(device.key).link);
  });

  it("answers a root that accepts again, by another identity, with 200 and an acknowledgement of that acceptance", async () => {
    const { service } = await memoryService();
    const { offer } = await rootOf(service);
    expect((await postAcceptance(service, (await directAcceptance(offer, wallet)).zip)).status).toBe(201);
    const again = await delegatedAcceptance(offer);
    const response = await postAcceptance(service, again.zip);
    expect(response.status).toBe(200);
    expect((await acknowledgementIn(response)).acknowledgement.data.acceptance.$link).toBe(again.signature.link);
  });

  it("answers 400 to an agent that a later identity version of its root removed, though the root has an account", async () => {
    const { service, store } = await memoryService();
    const { offer } = await rootOf(service);
    const first = await publish(wallet, { agents: [device.key, phone.key], at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [phone.key], at: 2_000 });
    expect((await postAcceptance(service, await acceptanceBy(phone, second, offer))).status).toBe(201);
    const recordsBefore = await records(store);
    const response = await postAcceptance(service, await acceptanceBy(device, first, offer));
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not count/);
    expect(await records(store)).toEqual(recordsBefore);
  });

  it("answers 400 to an agent that a later identity version removed, though the agent opened the account before it came", async () => {
    const { service, store } = await memoryService();
    const { offer } = await rootOf(service);
    const removed = await publish(wallet, { agents: [device.key], at: 1_000 });
    const removedAcceptance = await acceptanceBy(device, removed, offer);
    expect((await postAcceptance(service, removedAcceptance)).status).toBe(201);
    const second = await publish(wallet, { prior: removed, agents: [phone.key], at: 2_000 });
    expect((await postAcceptance(service, await acceptanceBy(phone, second, offer))).status).toBe(200);
    expect((await postAcceptance(service, removedAcceptance)).status).toBe(400);
    const { service: again } = await memoryService({ store });
    expect((await postAcceptance(again, removedAcceptance)).status).toBe(400);
  });

  it("answers 400 to an agent whose body comes in only after a later identity version removed it, and signs nothing for it", async () => {
    const { service, store } = await memoryService();
    const { offer, acceptId } = await rootOf(service);
    const removed = await publish(wallet, { agents: [device.key], at: 1_000 });
    const removedAcceptance = await acceptanceBy(device, removed, offer);
    let reportPull = () => {};
    const firstPull = new Promise<void>((resolve) => (reportPull = resolve));
    let release = () => {};
    const bodyRelease = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reportPull();
          await bodyRelease;
          controller.enqueue(removedAcceptance);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const pendingResponse = service.fetch(
      request(`/${acceptId}`, { method: "POST", body, duplex: "half" } as RequestInit),
    );
    await firstPull;
    const second = await publish(wallet, { prior: removed, agents: [phone.key], at: 2_000 });
    expect((await postAcceptance(service, await acceptanceBy(phone, second, offer))).status).toBe(201);
    const recordsBefore = await records(store);
    release();
    const response = await pendingResponse;
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not count/);
    expect(await records(store)).toEqual(recordsBefore);
  });

  it("answers two acceptances that open one account at once with 201 and 200, each acknowledged, and has seen the identity versions of both", async () => {
    const holder = heldSigner(serviceSigner);
    const { service } = await memoryService({ by: holder.signer });
    const { offer } = await rootOf(service);
    const listing = await publish(wallet, { agents: [device.key], at: 1_000 });
    const earlier = await acceptanceBy(device, listing, offer);
    const later = await acceptanceBy(wallet, await publish(wallet, { prior: listing, at: 2_000 }), offer);
    holder.isHolding = true;
    const opener = postAcceptance(service, earlier);
    await vi.waitFor(() => expect(holder.pending).toHaveLength(1));
    const racer = postAcceptance(service, later);
    await vi.waitFor(() => expect(holder.pending).toHaveLength(2));
    holder.isHolding = false;
    holder.release();
    const openerAnswer = await opener;
    holder.release();
    const racerAnswer = await racer;
    expect([openerAnswer.status, racerAnswer.status]).toEqual([201, 200]);
    for (const [response, zip] of [
      [openerAnswer, earlier],
      [racerAnswer, later],
    ] as const) {
      const { acknowledgement } = await acknowledgementIn(response);
      expect(acknowledgement.data.acceptance.$link).toBe((await unpackBundle(zip)).link);
    }
    expect((await postAcceptance(service, earlier)).status).toBe(400);
  });

  it("answers one acceptance posted twice at once with 201 and 200, each acknowledging it, and later with the acknowledgement whose signature has the least link", async () => {
    const holder = heldSigner(serviceSigner);
    const { service, store } = await memoryService({ by: holder.signer });
    const { signature: acceptance, zip } = await directAcceptance((await rootOf(service)).offer);
    holder.isHolding = true;
    const opener = postAcceptance(service, zip);
    await vi.waitFor(() => expect(holder.pending).toHaveLength(1));
    const racer = postAcceptance(service, zip);
    await vi.waitFor(() => expect(holder.pending).toHaveLength(2));
    holder.isHolding = false;
    holder.release();
    const openerAnswer = await opener;
    holder.release();
    const racerAnswer = await racer;
    expect([openerAnswer.status, racerAnswer.status]).toEqual([201, 200]);
    const answers = await Promise.all([openerAnswer, racerAnswer].map(acknowledgementIn));
    for (const { acknowledgement } of answers) expect(acknowledgement.data.acceptance.$link).toBe(acceptance.link);
    const recordsBefore = await records(store);
    const again = await postAcceptance(service, zip);
    expect(again.status).toBe(200);
    const [least] = answers.map(({ signature }) => signature.link).sort();
    expect((await acknowledgementIn(again)).signature.link).toBe(least);
    expect(await records(store)).toEqual(recordsBefore);
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
    const response = await postAcceptance(service, await body(service));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toBe("");
    expect(await records(store)).toEqual([(await rootOf(service)).signature.link]);
  });

  it("answers 413 to a body of more than 64 KiB", async () => {
    const { service } = await memoryService();
    expect((await postAcceptance(service, new Uint8Array(64 * 1024 + 1))).status).toBe(413);
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
    const droppedOffer = encodeObject(schema, { identity: { $link: serviceRoot.link } });
    const asService = await serviceActor(3_000);
    const offerSignature = await asService.sign(droppedOffer);
    const earlier = encodeObject(serviceSchemaRead, {
      origin: "https://mail.example",
      at: 2_000,
      offers: [{ offer: { $link: offerSignature.link }, acceptId: droppedOffer.link }],
    });
    const blobs = [earlier.bytes, offerSignature.bytes, droppedOffer.bytes, ...schema.blobs];
    await store.write({ records: [await asService.sign(earlier)], blobs });
    expect((await post(service, droppedOffer.link, (await directAcceptance(droppedOffer)).zip)).status).toBe(410);
  });

  it("answers with the latest Service that its store holds, which a start elsewhere may have signed since", async () => {
    const { service, store } = await memoryService();
    await memoryService({ store, origin: "https://post.example", start: 9_000 });
    const { data, acceptId, offer } = await rootOf(service);
    expect(data).toMatchObject({ origin: "https://post.example", at: 9_000 });
    expect((await post(service, acceptId, (await directAcceptance(offer)).zip)).status).toBe(201);
  });

  it("acknowledges as a crisis of its root once another start on its store signed a Service as it, without starting again", async () => {
    const { service, store, accounts, mailboxes } = await memoryService();
    const crisis = await publish(serviceSigner, {
      prior: (await rootOf(service)).signature.signedIdentity,
      isCrisis: true,
      at: 2_000,
    });
    await store.write({ records: [crisis], blobs: crisis.blobs });
    await memoryService({ store, accounts, mailboxes, start: 3_000 });
    const actor = await actorOf(alice);
    const accepted = await postAcceptance(service, (await directAcceptance((await rootOf(service)).offer)).zip);
    expect(accepted.status).toBe(201);
    const { signature } = await acknowledgementIn(accepted);
    const mailbox = await openMailbox(service, actor);
    const people = await view(store, peopleView(identityVersions));
    for (const link of [signature.link, mailbox.link])
      expect((await signatures.read(link, store, people)).signedIdentity.link).toBe(crisis.link);
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
    let startsLeft = 2;
    const by: Signer = {
      key: serviceSigner.key,
      async sign(digest, signedIdentity) {
        if (--startsLeft === 0) release();
        await bothRead;
        return serviceSigner.sign(digest, signedIdentity);
      },
    };
    const store = memoryStore();
    const starts = await Promise.all(
      ["https://one.example", "https://two.example"].map((origin) =>
        memoryService({ store, by, origin, start: 10_000 }),
      ),
    );
    const serviceSignatures = await Promise.all(
      (await records(store)).map((link) => signatures.read(link, store, noIdentityVersions)),
    );
    const ats = await Promise.all(
      serviceSignatures.map(async ({ object }) => (await readObject(store, object, serviceSchemaRead)).data.at),
    );
    expect(ats).toEqual([10_000, 10_000]);
    const [one, two] = await Promise.all(starts.map(({ service }) => rootOf(service)));
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

  it("signs as the current identity version of its root, which its signer does not sign again", async () => {
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

  it("once its root signed a crisis, signs as it, and keeps the accounts and the mailboxes it opened", async () => {
    const { service, store, accounts, mailboxes } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const mailbox = await openMailbox(service, actor);
    const before = await rootOf(service);
    const crisis = await publish(serviceSigner, { prior: before.signature.signedIdentity, isCrisis: true, at: 2_000 });
    await store.write({ records: [crisis], blobs: crisis.blobs });
    const { service: again } = await memoryService({ store, accounts, mailboxes, start: 3_000 });
    const after = await rootOf(again);
    expect(after.signature.signedIdentity.link).toBe(crisis.link);
    expect(after.acceptId).toBe(before.acceptId);
    const people = await view(store, peopleView(identityVersions));
    for (const { link } of [after.signature, after.offerSignature, after.mailbox.offerSignature])
      expect((await signatures.read(link, store, people)).signedIdentity.link).toBe(crisis.link);
    await openMailbox(again, actor, keyOf(0x22));
    expect((await post(again, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    expect(await queueAt(again, mailbox, actor)).toEqual([ciphertextOf(1)]);
  });

  it("once its root signed a crisis, answers an acceptance and a request posted again with their acknowledgements signed again as it", async () => {
    const { service, store, accounts, mailboxes } = await memoryService();
    const actor = await actorOf(alice);
    const before = await rootOf(service);
    const acceptance = await directAcceptance(before.offer);
    const accepted = await acknowledgementIn(await postAcceptance(service, acceptance.zip));
    const { zip } = await mailboxRequest(actor, before.mailbox.offer);
    const opened = await mailboxAcknowledgementIn(await postMailboxRequest(service, zip));
    expect((await post(service, opened.acknowledgement.data.sendId, ciphertextOf(1))).status).toBe(204);
    const crisis = await publish(serviceSigner, { prior: before.signature.signedIdentity, isCrisis: true, at: 2_000 });
    await store.write({ records: [crisis], blobs: crisis.blobs });
    const { service: again } = await memoryService({ store, accounts, mailboxes, start: 3_000 });
    const acceptedAgain = await postAcceptance(again, acceptance.zip);
    expect(acceptedAgain.status).toBe(200);
    const reaccepted = await acknowledgementIn(acceptedAgain);
    const openedAgain = await postMailboxRequest(again, zip);
    expect(openedAgain.status).toBe(200);
    const reopened = await mailboxAcknowledgementIn(openedAgain);
    const people = await view(store, peopleView(identityVersions));
    for (const [renewed, first] of [
      [reaccepted, accepted],
      [reopened, opened],
    ] as const) {
      expect(renewed.signature.object).toBe(first.signature.object);
      expect((await signatures.read(renewed.signature.link, store, people)).signedIdentity.link).toBe(crisis.link);
    }
    const recordsBefore = await records(store);
    expect((await acknowledgementIn(await postAcceptance(again, acceptance.zip))).signature.link).toBe(
      reaccepted.signature.link,
    );
    expect(await records(store)).toEqual(recordsBefore);
    const mailbox = { link: reopened.signature.link, ...reopened.acknowledgement.data };
    expect(await queueAt(again, mailbox, actor)).toEqual([ciphertextOf(1)]);
  });

  it("at another origin with its clock behind signs a Service earlier than the one before, which stays the latest", async () => {
    const { service, store } = await memoryService({ start: 5_000 });
    const before = await rootOf(service);
    const { service: movedService } = await memoryService({ store, origin: "https://post.example", start: 1_000 });
    expect((await rootOf(movedService)).data).toEqual(before.data);
    const serviceSignatures = await Promise.all(
      (await records(store)).map((link) => signatures.read(link, store, noIdentityVersions)),
    );
    const services = await Promise.all(
      serviceSignatures.map(async ({ object }) => (await readObject(store, object, serviceSchemaRead)).data),
    );
    expect(services).toContainEqual({ ...before.data, origin: "https://post.example", at: 1_000 });
  });

  it("on the same SQLite file keeps the accounts and the mailboxes it opened, and what waits at them", async () => {
    const path = await makeTemporaryPath();
    const before = sqliteParts(path);
    const { service } = await memoryService(before);
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const mailbox = await openMailbox(service, actor);
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    before.close();
    const after = sqliteParts(path);
    onTestFinished(after.close);
    const { service: again } = await memoryService({ ...after, start: 9_000 });
    expect(await acceptAccount(again, actor)).toBe(200);
    const { zip } = await mailboxRequest(actor, (await rootOf(again)).mailbox.offer);
    expect((await postMailboxRequest(again, zip)).status).toBe(200);
    expect((await post(again, mailbox.sendId, ciphertextOf(2))).status).toBe(204);
    expect(await queueAt(again, mailbox, actor)).toEqual([ciphertextOf(1), ciphertextOf(2)]);
  });
});

/** The store, the accounts and the mailboxes of a service, all in the SQLite file at `path`. */
function sqliteParts(path: string) {
  const backend = new SqliteBackend(path);
  const accounts = new SqliteAccounts(path);
  const mailboxes = new SqliteMailboxes(path);
  const close = () => {
    backend.close();
    accounts.close();
    mailboxes.close();
  };
  return { store: new Store(json, backend), accounts, mailboxes, close };
}

const bob = signer(ed25519, 6);
const keyOf = (fill: number) => fill.toString(16).padStart(2, "0").repeat(32);
const ciphertextOf = (fill: number, length = 64) => new Uint8Array(length).fill(fill);

/** The status that `service` answers `actor`'s acceptance of its offer of an account with. */
async function acceptAccount(service: MailboxService, actor: Actor) {
  const signature = await actor.sign((await rootOf(service)).offer);
  return (await postAcceptance(service, await packBundle(signature, signature.signedIdentity.blobs))).status;
}

/** Opens the account of `actor`'s root at `service`, by the actor's acceptance of its offer. */
const openAccount = async (service: MailboxService, actor: Actor) =>
  expect(await acceptAccount(service, actor)).toBe(201);

/** The bundle of `actor`'s request for a mailbox sealed to `key`, by `offer`. */
async function mailboxRequest(actor: Actor, offer: { readonly link: Link<unknown> }, key = keyOf(0x11)) {
  const request = encodeObject(mailboxRequestSchemaRead, { offer: { $link: offer.link as Link<never> }, key });
  const signature = await actor.sign(request);
  return { signature, zip: await packBundle(signature, [request.bytes, ...signature.signedIdentity.blobs]) };
}

const postMailboxRequest = async (service: MailboxService, body: Uint8Array) =>
  post(service, (await rootOf(service)).mailbox.acceptId, body);

async function mailboxAcknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
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
  const { zip } = await mailboxRequest(actor, (await rootOf(service)).mailbox.offer, key);
  const response = await postMailboxRequest(service, zip);
  expect(response.status).toBe(201);
  const { signature, acknowledgement } = await mailboxAcknowledgementIn(response);
  return { link: signature.link, ...acknowledgement.data };
}

/** The bundle of `actor`'s request to pick up at the mailbox `mailbox` opened, with `receipts` for what it is done with. */
async function pickupRequest(actor: Actor, mailbox: OpenedMailbox, receipts: readonly Uint8Array[] = []) {
  const request = encodeObject(pickupRequestSchemaRead, {
    mailbox: mailbox.request,
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
  const response = await post(service, mailbox.pickupId, await pickupRequest(actor, mailbox, receipts));
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
    const { signature, zip } = await mailboxRequest(actor, mailbox.offer);
    const response = await postMailboxRequest(service, zip);
    expect(response.status).toBe(201);
    const { bundle, signature: acknowledgementSignature, acknowledgement } = await mailboxAcknowledgementIn(response);
    expect(acknowledgementSignature.signedIdentity.identity.link).toBe(serviceIdentity(5_000).link);
    const { sendId, pickupId } = acknowledgement.data;
    expect(acknowledgement.data).toEqual({ request: { $link: signature.link }, at: 5_002, sendId, pickupId });
    expect(sendId).toMatch(/^[0-9a-f]{32}$/);
    expect(pickupId).toMatch(/^[0-9a-f]{32}$/);
    expect(sendId).not.toBe(pickupId);
    const read = await signatures.read(signature.link, bundle, noIdentityVersions);
    const request = await readObject(bundle, read.object, mailboxRequestSchemaRead);
    expect(request.data).toEqual({ offer: { $link: mailbox.offer.link }, key: keyOf(0x11) });
    expect((await readObject(bundle, request.data.offer.$link, mailboxOfferSchemaRead)).data).toEqual(
      mailbox.offer.data,
    );
  });

  it("opens a mailbox for an agent that an identity of the root lists, under the account its wallet opened", async () => {
    const { service } = await memoryService();
    await openAccount(service, await actorOf(wallet));
    const agent = signatures.actor(device, await publish(wallet, { agents: [device.key] }));
    const { zip } = await mailboxRequest(agent, (await rootOf(service)).mailbox.offer);
    expect((await postMailboxRequest(service, zip)).status).toBe(201);
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
    const { zip } = await mailboxRequest(actor, (await rootOf(service)).mailbox.offer);
    const first = new Uint8Array(await (await postMailboxRequest(service, zip)).arrayBuffer());
    const recordsBefore = await records(store);
    const again = await postMailboxRequest(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
    expect(await records(store)).toEqual(recordsBefore);
  });

  it("answers one request posted twice at once with 201 and 200, each with the acknowledgement of the mailbox it opened", async () => {
    const holder = heldSigner(serviceSigner);
    const { service } = await memoryService({ by: holder.signer });
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { zip } = await mailboxRequest(actor, (await rootOf(service)).mailbox.offer);
    holder.isHolding = true;
    const opener = postMailboxRequest(service, zip);
    await vi.waitFor(() => expect(holder.pending).toHaveLength(1));
    const racer = postMailboxRequest(service, zip);
    await vi.waitFor(() => expect(holder.pending).toHaveLength(2));
    holder.isHolding = false;
    holder.release();
    const openerAnswer = await opener;
    holder.release();
    const racerAnswer = await racer;
    expect([openerAnswer.status, racerAnswer.status]).toEqual([201, 200]);
    const [first, second] = await Promise.all([openerAnswer, racerAnswer].map(mailboxAcknowledgementIn));
    expect(second?.signature.link).toBe(first?.signature.link);
    expect((await mailboxAcknowledgementIn(await postMailboxRequest(service, zip))).signature.link).toBe(
      first?.signature.link,
    );
  });

  it("answers 403 to a request by a root that has no account, and opens no mailbox", async () => {
    const { service, store } = await memoryService();
    const { zip } = await mailboxRequest(await actorOf(alice), (await rootOf(service)).mailbox.offer);
    const response = await postMailboxRequest(service, zip);
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/has no account here/);
    expect(await records(store)).toEqual([(await rootOf(service)).signature.link]);
  });

  it("answers 400 to a request by an agent that a later identity version of its root removed, though the root has an account", async () => {
    const { service } = await memoryService();
    const { mailbox } = await rootOf(service);
    const removedAgent = signatures.actor(device, await publish(wallet, { agents: [device.key], at: 1_000 }));
    await openAccount(service, removedAgent);
    expect(
      await acceptAccount(
        service,
        signatures.actor(
          phone,
          await publish(wallet, { prior: removedAgent.signedIdentity, agents: [phone.key], at: 2_000 }),
        ),
      ),
    ).toBe(200);
    const response = await postMailboxRequest(service, (await mailboxRequest(removedAgent, mailbox.offer)).zip);
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not count/);
  });

  it.each<[string, (service: MailboxService, actor: Actor) => Promise<Uint8Array>]>([
    [
      "for the offer of an account",
      async (service, actor) => (await mailboxRequest(actor, (await rootOf(service)).offer)).zip,
    ],
    [
      "for another service's offer of mailboxes",
      async (_, actor) => {
        const { service: other } = await memoryService({ by: otherService });
        return (await mailboxRequest(actor, (await rootOf(other)).mailbox.offer)).zip;
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
    const recordsBefore = await records(store);
    const response = await postMailboxRequest(service, await body(service, actor));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toBe("");
    expect(await records(store)).toEqual(recordsBefore);
  });

  it("keeps the mailboxes it opened on the terms of their offer once it offers other terms", async () => {
    const { service, store, accounts, mailboxes } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const before = await rootOf(service);
    const mailbox = await openMailbox(service, actor);
    const offeredTerms = { ...terms, size: 100 };
    const { service: again } = await memoryService({ store, accounts, mailboxes, offeredTerms, start: 9_000 });
    const after = await rootOf(again);
    expect(after.mailbox.offer.data.size).toBe(100);
    expect(after.offerSignature.link).toBe(before.offerSignature.link);
    expect((await post(again, mailbox.sendId, ciphertextOf(1, 1_000))).status).toBe(204);
    expect(
      (await post(again, before.mailbox.acceptId, (await mailboxRequest(actor, before.mailbox.offer)).zip)).status,
    ).toBe(410);
  });

  it("opens a mailbox on the terms of the offer that the latest Service lists, though another start on its store signed it", async () => {
    const { service, ...shared } = await memoryService();
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { service: newer } = await memoryService({ ...shared, offeredTerms: { ...terms, size: 100 }, start: 9_000 });
    expect((await rootOf(service)).mailbox.offer.data.size).toBe(100);
    const mailbox = await openMailbox(service, actor);
    expect((await post(newer, mailbox.sendId, ciphertextOf(1, 101))).status).toBe(413);
    expect((await post(service, mailbox.sendId, ciphertextOf(1, 100))).status).toBe(204);
  });

  it("started again with its clock behind takes requests for the offer that the latest Service lists, and answers 410 at its own", async () => {
    const { service, ...shared } = await memoryService({ start: 5_000 });
    const actor = await actorOf(alice);
    await openAccount(service, actor);
    const { zip } = await mailboxRequest(actor, (await rootOf(service)).mailbox.offer);
    const first = new Uint8Array(await (await postMailboxRequest(service, zip)).arrayBuffer());
    const offeredTerms = { ...terms, size: 100 };
    const { service: behind } = await memoryService({ ...shared, offeredTerms, start: 1_000 });
    const again = await postMailboxRequest(behind, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
    const mailbox = await openMailbox(behind, actor, keyOf(0x22));
    expect((await post(behind, mailbox.sendId, ciphertextOf(1, 1_000))).status).toBe(204);
    const own = encodeObject(mailboxOfferSchemaRead, { identity: { $link: serviceRoot.link }, ...offeredTerms });
    expect((await post(behind, own.link, (await mailboxRequest(actor, own)).zip)).status).toBe(410);
  });
});

describe("a mailbox that a service opened", () => {
  async function serviceWithMailbox(options: Parameters<typeof memoryService>[0] = {}) {
    const run = await memoryService(options);
    const actor = await actorOf(alice);
    await openAccount(run.service, actor);
    return { ...run, actor, mailbox: await openMailbox(run.service, actor) };
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
    const ciphertextsFillingQuota = [1, 2, 3, 4].map((fill) => ciphertextOf(fill, terms.quota / 4));
    for (const ciphertext of [...ciphertextsFillingQuota, ...ciphertextsFillingQuota])
      expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    expect(await queueAt(service, mailbox, actor)).toEqual(ciphertextsFillingQuota);
  });

  it("answers 413 to a ciphertext over the size its offer names, and keeps nothing of it", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    expect((await post(service, mailbox.sendId, ciphertextOf(1, terms.size))).status).toBe(204);
    expect((await post(service, mailbox.sendId, ciphertextOf(2, terms.size + 1))).status).toBe(413);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(1, terms.size)]);
  });

  it("answers 429 once what waits would come to more than its quota, and takes ciphertexts again once a pickup has receipts for some", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    const ciphertextsFillingQuota = [1, 2, 3, 4].map((fill) => ciphertextOf(fill, terms.quota / 4));
    for (const ciphertext of ciphertextsFillingQuota)
      expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    const over = await post(service, mailbox.sendId, ciphertextOf(5));
    expect(over.status).toBe(429);
    expect(await over.text()).toMatch(/holds at most 4096 bytes/);
    await queueAt(service, mailbox, actor, ciphertextsFillingQuota.slice(0, 1));
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
    const ciphertextsFillingQuota = [1, 2, 3, 4].map((fill) => ciphertextOf(fill, terms.quota / 4));
    for (const ciphertext of ciphertextsFillingQuota)
      expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    clock.now += terms.retention;
    expect((await post(service, mailbox.sendId, ciphertextOf(5))).status).toBe(429);
    clock.now += 1;
    expect((await post(service, mailbox.sendId, ciphertextOf(5))).status).toBe(204);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(5)]);
  });

  it("answers a pickup with 100 ciphertexts at most, the earliest first", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox({
      offeredTerms: { ...terms, size: 2, quota: 2 * 101 },
    });
    const ciphertexts = Array.from({ length: 101 }, (_, n) => new Uint8Array([n >> 8, n & 0xff]));
    for (const ciphertext of ciphertexts) expect((await post(service, mailbox.sendId, ciphertext)).status).toBe(204);
    const first = await queueAt(service, mailbox, actor);
    expect(first).toEqual(ciphertexts.slice(0, 100));
    expect(await queueAt(service, mailbox, actor, ciphertexts.slice(0, 100))).toEqual(ciphertexts.slice(100));
  });

  it("answers a pickup with ciphertexts that come to 1 MiB at most, but with the earliest alone when it is larger", async () => {
    const KiB = 1024;
    const { service, actor, mailbox } = await serviceWithMailbox({
      offeredTerms: { ...terms, size: 1_536 * KiB, quota: 4_096 * KiB },
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

  it("answers a pickup by an agent that an identity version of the root lists which it has not seen, by the identity version that the request carries", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    const listedAgent = signatures.actor(
      phone,
      await publish(alice, { prior: actor.signedIdentity, agents: [phone.key], at: 2_000 }),
    );
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    expect(await queueAt(service, mailbox, listedAgent)).toEqual([ciphertextOf(1)]);
  });

  it("answers 403 to a pickup signed for another root, and is done with nothing", async () => {
    const { service, actor, mailbox } = await serviceWithMailbox();
    expect((await post(service, mailbox.sendId, ciphertextOf(1))).status).toBe(204);
    const other = await actorOf(bob);
    await openAccount(service, other);
    const response = await post(service, mailbox.pickupId, await pickupRequest(other, mailbox, [ciphertextOf(1)]));
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/another root/);
    expect(await queueAt(service, mailbox, actor)).toEqual([ciphertextOf(1)]);
  });

  it("answers 403 to a pickup by an agent that a later identity version of the root, which it has seen, takes out", async () => {
    const { service } = await memoryService();
    const removedAgent = signatures.actor(device, await publish(wallet, { agents: [device.key], at: 1_000 }));
    await openAccount(service, removedAgent);
    const mailbox = await openMailbox(service, removedAgent);
    const listedAgent = signatures.actor(
      phone,
      await publish(wallet, { prior: removedAgent.signedIdentity, agents: [phone.key], at: 2_000 }),
    );
    expect(await acceptAccount(service, listedAgent)).toBe(200);
    const response = await post(service, mailbox.pickupId, await pickupRequest(removedAgent, mailbox));
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/does not count/);
    expect(await queueAt(service, mailbox, listedAgent)).toEqual([]);
  });

  it.each<[string, (actor: Actor, mailbox: OpenedMailbox, other: OpenedMailbox) => Promise<Uint8Array>]>([
    ["that names another mailbox", (actor, _, other) => pickupRequest(actor, other)],
    [
      "that names the mailbox by its acknowledgement",
      (actor, mailbox) => pickupRequest(actor, { ...mailbox, request: { $link: mailbox.link } }),
    ],
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
