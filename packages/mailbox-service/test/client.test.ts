import { type Bundle, decodeBundle, encodeBundle } from "@estoc/bundle";
import { type Actor, ed25519, eip191, type Signer, solanaOffchain } from "@estoc/identity";
import { mailboxAt, mailboxSchema, type Pickup, Post } from "@estoc/mailbox";
import { httpTransport as http } from "@estoc/mailbox/http";
import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, readObject } from "@estoc/object";
import { link, schema, string } from "@estoc/schema";
import { Intake, inboundSchema, type Store } from "@estoc/store";
import { hex } from "@scure/base";
import { afterEach, assert, describe, expect, it } from "vitest";
import {
  accountOfferSchema,
  acknowledgementSchema,
  loadServices,
  type MailboxOffer,
  mailboxAcknowledgementSchema,
  mailboxOfferSchema,
  mailboxRequestSchema,
  openedMailboxSchema,
  originSchema,
  type Services,
  serviceSchema,
} from "../src/index.ts";
import { serve } from "../src/node.ts";
import type { MailboxService } from "../src/server.ts";
import {
  actorOf,
  actorSigningBy,
  keys,
  memoryService,
  memoryStore,
  publish,
  schemes,
  serviceActor,
  serviceIdentity,
  serviceRoot,
  serviceSigner,
  signatures,
  signedAtOrigins,
  signer,
  terms,
} from "./fixtures.ts";

const alice = signer(ed25519, 1);
const bob = signer(ed25519, 5);
const wallet = signer(eip191, 2);
const laptop = signer(ed25519, 3);
const phone = signer(solanaOffchain, 4);
const mallory = signer(ed25519, 6);

const offer = encodeObject(accountOfferSchema, { identity: new LinkValue(serviceRoot.link) });

const agentOf = async (agent: Signer, root: Signer) =>
  actorSigningBy(agent, await publish(root, { agents: [agent.key] }));

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => void (await Promise.all(servers.splice(0).map((server) => server.close()))));

/** Serves at an origin of 127.0.0.1 what `handle` makes, given that origin, for each request. */
async function startServer(handle: (request: Request, origin: string) => Promise<Response>) {
  const server = await serve((request) => handle(request, server.origin), 0);
  servers.push(server);
  return server;
}

/**
 * Runs a service in memory at an origin of 127.0.0.1, which it is loaded
 * with, and answers a `POST` as `answer` does when it is given.
 */
async function startService(
  options: Parameters<typeof memoryService>[0] = {},
  answer?: (service: MailboxService, request: Request) => Promise<Response>,
) {
  let run: Awaited<ReturnType<typeof memoryService>> | undefined;
  const server = await startServer(async (request) => {
    assert.exists(run);
    return answer !== undefined && request.method === "POST"
      ? answer(run.service, request)
      : run.service.fetch(request);
  });
  run = await memoryService({ ...options, origin: server.origin });
  return { ...run, origin: server.origin, close: () => server.close() };
}

/**
 * What the Inbounds among the records of `store` say came in, each as the link of its root and the origin it
 * came from.
 */
async function inboundRowsOf(store: Store) {
  const rows: (readonly [Link<never>, string])[] = [];
  for await (const statement of store.records()) {
    const inbound = await objectsOf(inboundSchema).read(statement, store);
    if (inbound === undefined) continue;
    const { bundle, via } = inbound.data;
    assert.exists(via);
    rows.push([bundle.link, (await readObject(store, via.link, originSchema)).data.origin]);
  }
  return rows.sort(([a], [b]) => (a < b ? -1 : 1));
}

function client() {
  const store = memoryStore();
  return { store, services: loadServices(store, { schemes }) };
}

async function accountAt(services: Services, origin: string) {
  const { account } = await services.fetch(origin);
  assert.exists(account);
  return account;
}

async function signedService(origin: string, offers: readonly EncodedObject[], by: Actor, at = 1) {
  const listedOffers = offers.map(({ link }) => new LinkValue(link));
  const service = encodeObject(serviceSchema, { origin, at, offers: listedOffers });
  const signature = await by.sign(service);
  const blobs = [
    service.bytes,
    ...serviceSchema.blobs,
    ...offers.flatMap((object) => [object.bytes, ...object.schema.blobs]),
    ...serviceRoot.blobs,
  ];
  return encodeBundle(signature.link, [...signature.blobs, ...blobs]);
}

/** Writes to `store` a mailbox whose messages are sealed to `keyOf(7)`, at an HTTP transport object at `url`. */
async function writeMailbox(store: Store, url: string) {
  const transport = encodeObject(http.schema, { url });
  const mailbox = encodeObject(mailboxSchema, { key: keyOf(7), transport: new LinkValue(transport.link) });
  await store.write({
    roots: [mailbox.link],
    blobs: [mailbox.bytes, ...mailboxSchema.blobs, transport.bytes, ...http.schema.blobs],
  });
  return mailbox;
}

/** Keeps `bundle` in `store` as come in at a mailbox elsewhere. */
async function receiveAtMailbox(store: Store, bundle: Bundle) {
  const mailbox = await writeMailbox(store, `https://elsewhere.example/${"1".repeat(32)}`);
  await new Intake(store).receive(bundle, mailbox);
}

/**
 * Writes to `store` an identity version of the service that takes out an
 * agent that the one before listed, and gives an actor for that agent by the
 * one before.
 */
async function removeAgent(store: Store) {
  const agent = signer(ed25519, 7);
  const earlier = await publish(serviceSigner, { agents: [agent.key], at: 1_500 });
  const later = await publish(serviceSigner, { prior: earlier, at: 2_000 });
  await store.write({ roots: [later.link], blobs: later.blobs });
  return actorSigningBy(agent, earlier);
}

/** The answer to a posted acceptance with `by`'s signature over an acknowledgement of it, with its closure. */
async function acknowledgementBy(by: Actor, request: Request) {
  const acceptance = decodeBundle(new Uint8Array(await request.arrayBuffer()));
  const acknowledgement = encodeObject(acknowledgementSchema, { acceptance: new LinkValue(acceptance.link), at: 1 });
  const signature = await by.sign(acknowledgement);
  const blobs = [
    acknowledgement.bytes,
    ...acknowledgementSchema.blobs,
    acceptance.root,
    ...acceptance.blobs(),
    offer.bytes,
    ...accountOfferSchema.blobs,
    ...serviceRoot.blobs,
  ];
  return new Response(encodeBundle(signature.link, [...signature.blobs, ...blobs]), { status: 201 });
}

describe("a service reached at its origin", () => {
  it("is the identity that signed the Service there, which the store keeps as come in from that origin", async () => {
    const { origin } = await startService({ start: 2_000 });
    const { store, services } = client();
    const service = await services.fetch(origin);
    expect(service).toMatchObject({ origin, at: 2_000 });
    expect(service.signedIdentity.identity).toEqual(serviceIdentity(2_000));
    expect(service.account?.service).toBe(service.signedIdentity);
    expect(service.account?.link).toBe(offer.link);
    expect(await inboundRowsOf(store)).toEqual([[service.link, origin]]);
    expect((await signatures.read(service.link, store)).signedIdentity.identity.link).toBe(serviceIdentity(2_000).link);
  });

  it.each([
    ["a url with a path", "https://mail.example/inbox"],
    ["plain http to another machine", "http://mail.example"],
    ["not a url", "mail.example"],
  ])("refuses %s as the origin", async (_, origin) => {
    const { services } = client();
    await expect(services.fetch(origin)).rejects.toThrow();
  });

  it("refuses a Service that names another origin, and writes nothing", async () => {
    const { service } = await memoryService({ origin: "https://mail.example" });
    const { origin } = await startServer((request) => service.fetch(request));
    const { store, services } = client();
    await expect(services.fetch(origin)).rejects.toThrow(`the Service at ${origin} names https://mail.example`);
    expect(await inboundRowsOf(store)).toEqual([]);
  });

  it("refuses a Service by an agent that an identity version of the service, which the store holds, takes out, and writes nothing", async () => {
    const { store, services } = client();
    const removedActor = await removeAgent(store);
    const { origin } = await startServer(
      async (_, origin) => new Response(await signedService(origin, [offer], removedActor)),
    );
    await expect(services.fetch(origin)).rejects.toThrow(/is not honored/);
    expect(await inboundRowsOf(store)).toEqual([]);
  });

  it("takes what a service signs by its root while the store holds a later identity version that lists the root, which the service has not seen", async () => {
    const { origin } = await startService({ start: 1_000 });
    const { store, services } = client();
    const { signedIdentity: later } = await serviceActor(2_000);
    await store.write({ roots: [later.link], blobs: later.blobs });
    const account = await (await accountAt(services, origin)).accept(await actorOf(alice));
    expect(account.service.identity.link).toBe(serviceIdentity(1_000).link);
  });

  it("refuses an account offer that names another identifier than that of the identity that signed the Service", async () => {
    const { origin } = await startServer(
      async (_, origin) => new Response(await signedService(origin, [offer], await actorOf(mallory))),
    );
    const { services } = client();
    await expect(services.fetch(origin)).rejects.toThrow(/lists an account offer that names another identifier/);
  });

  it("passes over an offer of a schema it does not read", async () => {
    const other = schema("Other offer", { identity: link() });
    const unread = encodeObject(other, { identity: new LinkValue(serviceRoot.link) });
    const actor = await actorOf(serviceSigner);
    const { origin } = await startServer(
      async (_, origin) => new Response(await signedService(origin, [unread, offer], actor)),
    );
    const { services } = client();
    expect((await services.fetch(origin)).account?.link).toBe(offer.link);
  });
});

describe("a service found by its identifier", () => {
  it("is the Service with the latest at that the store holds, whichever came first, read without reaching the service", async () => {
    const first = await startService({ start: 1_000 });
    const movedService = await startService({ start: 5_000 });
    const { services } = client();
    await services.fetch(movedService.origin);
    const { signedIdentity } = await services.fetch(first.origin);
    await Promise.all([first.close(), movedService.close()]);
    expect(await services.latestOf(signedIdentity)).toMatchObject({ origin: movedService.origin, at: 5_000 });
  });

  it("gives the offer of an account that the latest Service lists, taken at its origin", async () => {
    const first = await startService();
    const { services } = client();
    const { signedIdentity } = await services.fetch(first.origin);
    const movedService = await startService({ store: first.store, clock: { now: 5_000 } });
    await services.fetch(movedService.origin);
    await first.close();
    const account = (await services.latestOf(signedIdentity))?.account;
    assert.exists(account);
    expect((await account.accept(await actorOf(alice))).at).toBe(5_000);
  });

  it("is, of two Services at the same at, the one whose signature has the greater link, whichever the store took first", async () => {
    const { origin } = await startService();
    const [first, second] = [client(), client()];
    const { link, signedIdentity } = await first.services.fetch(origin);
    await second.services.fetch(origin);
    const { data } = await readObject(first.store, (await signatures.read(link, first.store)).object, serviceSchema);
    const origins = ["https://one.example", "https://two.example"];
    const [greater, lesser] = await signedAtOrigins({ ...data, at: 9_000 }, origins);
    assert.exists(greater);
    assert.exists(lesser);
    for (const { object, signature } of [greater, lesser])
      await first.store.write({ roots: [signature.link], blobs: [...signature.blobs, object.bytes] });
    for (const { object, signature } of [lesser, greater])
      await second.store.write({ roots: [signature.link], blobs: [...signature.blobs, object.bytes] });
    for (const { services } of [first, second]) {
      expect(await services.latestOf(signedIdentity)).toMatchObject({
        origin: greater.object.data.origin,
        link: greater.signature.link,
      });
    }
  });

  it("is read from a Service that came in at a mailbox as from one fetched", async () => {
    const actor = await serviceActor(1_000);
    const bundle = decodeBundle(await signedService("https://mail.example", [offer], actor));
    const { store, services } = client();
    await receiveAtMailbox(store, bundle);
    const service = await services.latestOf(actor.signedIdentity);
    expect(service).toMatchObject({ origin: "https://mail.example", link: bundle.link });
    expect(service?.account?.link).toBe(offer.link);
  });

  it("is of the Services by keys that the current identity version lists, however late one by a key taken out is", async () => {
    const { origin } = await startService();
    const { store, services } = client();
    const { link, signedIdentity } = await services.fetch(origin);
    const removedActor = await removeAgent(store);
    await receiveAtMailbox(store, decodeBundle(await signedService(origin, [], removedActor, 9_000)));
    expect((await services.latestOf(signedIdentity))?.link).toBe(link);
  });

  it("is undefined once the store holds a crisis that follows the identity version that signed each Service", async () => {
    const { origin } = await startService();
    const { store, services } = client();
    const { signedIdentity } = await services.fetch(origin);
    const later = await publish(serviceSigner, {
      prior: signedIdentity,
      isCrisis: true,
      at: signedIdentity.identity.at + 1,
    });
    await store.write({ roots: [later.link], blobs: later.blobs });
    expect(await services.latestOf(signedIdentity)).toBeUndefined();
  });

  it("is undefined for someone of whom the store holds no Service", async () => {
    const { origin } = await startService();
    const { services } = client();
    const { signedIdentity } = await actorOf(serviceSigner);
    expect(await services.latestOf(signedIdentity)).toBeUndefined();
    await services.fetch(origin);
    expect(await services.latestOf((await actorOf(alice)).signedIdentity)).toBeUndefined();
  });
});

describe("an account offer", () => {
  it("accepted by an identity opens its account, and the store keeps the service's signature over the acknowledgement", async () => {
    const clock = { now: 7_000 };
    const { origin } = await startService({ start: 7_000, clock });
    const { store, services } = client();
    const service = await services.fetch(origin);
    assert.exists(service.account);
    const actor = await actorOf(alice);
    clock.now = 8_000;
    const account = await service.account.accept(actor);
    expect(account).toEqual({
      signedIdentity: actor.signedIdentity,
      service: service.signedIdentity,
      at: 8_000,
      link: account.link,
    });
    expect(await inboundRowsOf(store)).toEqual([service.link, account.link].sort().map((link) => [link, origin]));
    const acknowledgement = await signatures.read(account.link, store);
    expect(acknowledgement.signedIdentity.identity.link).toBe(serviceIdentity(7_000).link);
    const { acceptance } = (await readObject(store, acknowledgement.object, acknowledgementSchema)).data;
    const acceptanceSignature = await signatures.read(acceptance.link, store);
    expect(acceptanceSignature.object).toBe(offer.link);
    expect(acceptanceSignature.signedIdentity.link).toBe(account.signedIdentity.link);
  });

  it("accepted by an agent that an identity lists opens the account of whoever it signs for", async () => {
    const { origin } = await startService();
    const { services } = client();
    const actor = await agentOf(laptop, wallet);
    const account = await (await accountAt(services, origin)).accept(actor);
    expect(account.signedIdentity).toBe(actor.signedIdentity);
    expect(account.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
  });

  it("accepted again from another device gets an acknowledgement of that device's acceptance, which its store keeps", async () => {
    const { origin } = await startService();
    const signedIdentity = await publish(wallet, { agents: [laptop.key, phone.key] });
    const first = await (await accountAt(client().services, origin)).accept(actorSigningBy(laptop, signedIdentity));
    const { store, services } = client();
    const again = await (await accountAt(services, origin)).accept(actorSigningBy(phone, signedIdentity));
    expect(again.link).not.toBe(first.link);
    expect(await inboundRowsOf(store)).toContainEqual([again.link, origin]);
    const acknowledgement = await readObject(
      store,
      (await signatures.read(again.link, store)).object,
      acknowledgementSchema,
    );
    const acceptance = await signatures.read(acknowledgement.data.acceptance.link, store);
    expect(acceptance.key.link).toBe(keys.encode(phone.key).link);
  });

  it("whose service refuses the acceptance throws what the service said, and writes nothing", async () => {
    const { origin } = await startService();
    const { store, services } = client();
    const service = await services.fetch(origin);
    assert.exists(service.account);
    const itself = await actorOf(serviceSigner);
    await expect(service.account.accept(itself)).rejects.toThrow(/answered 400: a service opens no account for itself/);
    expect(await inboundRowsOf(store)).toEqual([[service.link, origin]]);
  });
});

describe("accepting an account offer", () => {
  it("refuses an acknowledgement signed for another identifier than the service's, and writes nothing", async () => {
    const { origin } = await startService({}, async (_, request) => acknowledgementBy(await actorOf(mallory), request));
    const { store, services } = client();
    const account = await accountAt(services, origin);
    await expect(account.accept(await actorOf(alice))).rejects.toThrow(/signed for another identifier/);
    expect(await inboundRowsOf(store)).toHaveLength(1);
  });

  it("refuses an acknowledgement by an agent that a later identity version of the service, which the store holds, does not list", async () => {
    const [removedAgent, listedAgent] = [signer(ed25519, 7), signer(ed25519, 8)];
    const earlier = actorSigningBy(
      removedAgent,
      await publish(serviceSigner, { agents: [removedAgent.key], at: 1_000 }),
    );
    const later = actorSigningBy(
      listedAgent,
      await publish(serviceSigner, { prior: earlier.signedIdentity, agents: [listedAgent.key], at: 2_000 }),
    );
    const { origin } = await startServer(async (request, origin) =>
      request.method === "POST"
        ? acknowledgementBy(earlier, request)
        : new Response(await signedService(origin, [offer], later)),
    );
    const { store, services } = client();
    const account = await accountAt(services, origin);
    await expect(account.accept(await actorOf(alice))).rejects.toThrow(/is not honored/);
    expect(await inboundRowsOf(store)).toHaveLength(1);
  });

  it("refuses the service's acknowledgement of another acceptance than the one it sent, and writes nothing", async () => {
    const bobs = await (await actorOf(bob)).sign(offer);
    const { origin } = await startService({}, async (service, request) =>
      service.fetch(
        new Request(request.url, {
          method: "POST",
          body: encodeBundle(bobs.link, bobs.blobs),
        }),
      ),
    );
    const { store, services } = client();
    const account = await accountAt(services, origin);
    await expect(account.accept(await actorOf(alice))).rejects.toThrow(/not the one sent/);
    expect(await inboundRowsOf(store)).toHaveLength(1);
  });
});

const keyOf = (fill: number) => new Uint8Array(32).fill(fill);
const postTo = (url: string, ciphertext: Uint8Array<ArrayBuffer>) => fetch(url, { method: "POST", body: ciphertext });

/**
 * A service running at an origin of 127.0.0.1, and a client whose store
 * holds its Service, at which whoever `actor` signs for opened an account.
 */
async function withAccount(actor: Actor, options: Parameters<typeof startService>[0] = {}) {
  const run = await startService(options);
  const { store, services } = client();
  const { account, mailbox } = await services.fetch(run.origin);
  assert.exists(account);
  assert.exists(mailbox);
  await account.accept(actor);
  return { run, store, services, offer: mailbox };
}

/**
 * A mailbox for `key` at the HTTP transport object that `actor` opens by `offer`, both of which
 * `store` holds.
 */
async function openMailbox(store: Store, offer: MailboxOffer, actor: Actor, key = keyOf(7)) {
  const transport = await offer.open(actor, key);
  const mailbox = encodeObject(mailboxSchema, { key, transport: new LinkValue(transport.link) });
  await store.write({ roots: [mailbox.link], blobs: [mailbox.bytes, ...mailboxSchema.blobs] });
  return { transport, mailbox: mailbox.link };
}

/** The ciphertexts that `pickup` hands out, each dropped once it is. */
async function pickUpAll(pickup: Pickup, signal?: AbortSignal) {
  const ciphertexts: Uint8Array[] = [];
  for await (const arrival of pickup.arrivals(signal)) {
    ciphertexts.push(arrival.ciphertext);
    await arrival.drop();
  }
  return ciphertexts;
}

describe("a service's offer of mailboxes", () => {
  it("opened writes its transport object to the store, with a record of an Opened mailbox of it", async () => {
    const actor = await actorOf(alice);
    const { store, offer } = await withAccount(actor);
    const transport = await offer.open(actor, keyOf(7));
    expect(await store.get(transport.link)).toEqual(transport.bytes);
    const openedMailboxes = [];
    for await (const statement of store.records()) {
      const openedMailbox = await objectsOf(openedMailboxSchema).read(statement, store);
      if (openedMailbox !== undefined) openedMailboxes.push(openedMailbox);
    }
    expect(openedMailboxes.map(({ data }) => data.transport.link)).toEqual([transport.link]);
  });

  it("opened by an identity whose identifier has an account there gives an HTTP transport object at the service's origin, and the store keeps the acknowledgement as come in from there", async () => {
    const actor = await actorOf(alice);
    const { run, store, offer } = await withAccount(actor);
    expect(offer.terms).toEqual(terms);
    const before = await inboundRowsOf(store);
    const transport = await offer.open(actor, keyOf(7));
    expect(transport.schema.link).toBe(http.schema.link);
    const { pathname, origin } = new URL(transport.data.url);
    expect(origin).toBe(run.origin);
    const newRows = (await inboundRowsOf(store)).filter(([link]) => !before.some(([held]) => held === link));
    expect(newRows).toHaveLength(1);
    const [[acknowledgement, from] = []] = newRows;
    assert.exists(acknowledgement);
    expect(from).toBe(run.origin);
    const signature = await signatures.read(acknowledgement as Link<never>, store);
    const { sendId } = (await readObject(store, signature.object, mailboxAcknowledgementSchema)).data;
    expect(pathname).toBe(`/${hex.encode(sendId)}`);
  });

  it("opened by an identity whose identifier has no account there throws what the service said, and writes nothing", async () => {
    const { origin } = await startService();
    const { store, services } = client();
    const { link, mailbox } = await services.fetch(origin);
    assert.exists(mailbox);
    await expect(mailbox.open(await actorOf(alice), keyOf(7))).rejects.toThrow(/answered 403: .+ has no account here/);
    expect(await inboundRowsOf(store)).toEqual([[link, origin]]);
  });
});

describe("a mailbox that a service opened", () => {
  it("receives what a sender's post sends there, which an inbox collects with a pickup", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const options = { transports: [http] };
    const post = new Post(store, options);
    const inbox = await post.openInbox((publicKey) => offer.open(actor, publicKey));
    const sender = memoryStore();
    const noteSchema = schema("Note", { text: string() });
    const note = encodeObject(noteSchema, { text: "hello, Alice" });
    await sender.write({
      roots: [inbox.mailbox, note.link],
      blobs: [...(await store.closure(inbox.mailbox)).values(), note.bytes, ...noteSchema.blobs],
    });
    const senderPost = new Post(sender, options);
    const outbox = await senderPost.outbox(inbox.mailbox);
    await outbox.send(note.link);
    const [delivery, ...more] = await inbox.collect(await services.pickup(inbox.mailbox, actor));
    expect(more).toEqual([]);
    expect(delivery).toMatchObject({ direction: "inbound", bundle: note.link, mailbox: inbox.mailbox });
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await inbox.collect(await services.pickup(inbox.mailbox, actor))).toEqual([]);
  });

  it("is collected by its own inbox alone, though another inbox is opened at its transport object", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const options = { transports: [http] };
    const post = new Post(store, options);
    const inbox = await post.openInbox((publicKey) => offer.open(actor, publicKey));
    const { transport } = (await readObject(store, inbox.mailbox, mailboxSchema)).data;
    const other = await post.openInbox(() => readObject(store, transport.link, http.schema));
    const noteSchema = schema("Note", { text: string() });
    const note = encodeObject(noteSchema, { text: "hello, Alice" });
    await (await mailboxAt(inbox.mailbox, store, options)).send(note.link, [note.bytes, ...noteSchema.blobs]);

    await expect(services.pickup(other.mailbox, actor)).rejects.toThrow(
      `${other.mailbox} names another key than the one its transport was opened for`,
    );
    const pickup = await services.pickup(inbox.mailbox, actor);
    await expect(other.collect(pickup)).rejects.toThrow(
      `a pickup of ${inbox.mailbox} is not collected at ${other.mailbox}`,
    );
    expect((await inbox.collect(pickup)).map(({ bundle }) => bundle)).toEqual([note.link]);
  });

  it("is picked up by any agent that the root of its account lists", async () => {
    const signedIdentity = await publish(wallet, { agents: [laptop.key, phone.key] });
    const opener = actorSigningBy(laptop, signedIdentity);
    const { store, services, offer } = await withAccount(opener);
    const { transport, mailbox } = await openMailbox(store, offer, opener);
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    expect(await pickUpAll(await services.pickup(mailbox, actorSigningBy(phone, signedIdentity)))).toEqual([
      new Uint8Array([1]),
    ]);
  });

  it("is picked up where the latest Service that the store holds says, once the service moved", async () => {
    const actor = await actorOf(alice);
    const { run, store, services, offer } = await withAccount(actor);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    const movedService = await startService({
      store: run.store,
      accounts: run.accounts,
      mailboxes: run.mailboxes,
      start: 5_000,
    });
    await services.fetch(movedService.origin);
    await run.close();
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual([new Uint8Array([1])]);
  });

  it("is opened again by the same request, and picked up, once the root of its service signed a crisis and the service started again", async () => {
    let current: MailboxService | undefined;
    const server = await startServer(async (request) => {
      assert.exists(current);
      return current.fetch(request);
    });
    const run = await memoryService({ origin: server.origin });
    current = run.service;
    const actor = await actorOf(alice);
    const { store, services } = client();
    const before = await services.fetch(server.origin);
    assert.exists(before.account);
    assert.exists(before.mailbox);
    await before.account.accept(actor);
    const { transport, mailbox } = await openMailbox(store, before.mailbox, actor);
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    const crisis = await publish(serviceSigner, { prior: before.signedIdentity, isCrisis: true, at: 2_000 });
    await run.store.write({ roots: [crisis.link], blobs: crisis.blobs });
    const { accounts, mailboxes } = run;
    current = (await memoryService({ store: run.store, accounts, mailboxes, origin: server.origin, start: 3_000 }))
      .service;
    const after = await services.fetch(server.origin);
    assert.exists(after.account);
    assert.exists(after.mailbox);
    expect((await after.account.accept(actor)).service.link).toBe(crisis.link);
    expect((await openMailbox(store, after.mailbox, actor)).transport.link).toBe(transport.link);
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual([new Uint8Array([1])]);
  });

  it("is picked up where the service is, however late a Service by a key taken out is", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    const removedActor = await removeAgent(store);
    const lateServiceBundle = await signedService("https://elsewhere.example", [], removedActor, 9_000);
    await receiveAtMailbox(store, decodeBundle(lateServiceBundle));
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual([new Uint8Array([1])]);
  });

  it.each<[string, () => Promise<Actor>]>([
    ["by an identity", () => actorOf(alice)],
    [
      "by an agent of a root that lists so many that a request for a mailbox comes near 64 KiB",
      async () => {
        const [agent, ...more] = Array.from({ length: 120 }, (_, n) => signer(ed25519, 16 + n));
        assert.exists(agent);
        return actorSigningBy(agent, await publish(wallet, { agents: [agent, ...more].map(({ key }) => key) }));
      },
    ],
  ])("is picked up a batch at a time %s, each request done with the batch before", async (_, actorFor) => {
    const actor = await actorFor();
    const { run, store, services, offer } = await withAccount(actor);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    const send = new URL(transport.data.url).pathname;
    const ciphertexts = Array.from({ length: 101 }, (_, n) => new Uint8Array([n]));
    for (const ciphertext of ciphertexts) {
      const request = new Request(new URL(send, run.origin), { method: "POST", body: ciphertext });
      expect((await run.service.fetch(request)).status).toBe(204);
    }
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual(ciphertexts);
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual([]);
  });

  it("hands out what waits once in one pickup, though the receiver is not done with it", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    for (const fill of [1, 2]) expect((await postTo(transport.data.url, new Uint8Array([fill]))).status).toBe(204);
    const ciphertexts: Uint8Array[] = [];
    for await (const arrival of (await services.pickup(mailbox, actor)).arrivals()) {
      ciphertexts.push(arrival.ciphertext);
      if (ciphertexts.length > 2) break;
    }
    expect(ciphertexts).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  });

  it("keeps waiting what was done once the last request of a pickup was sent", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    for await (const arrival of (await services.pickup(mailbox, actor)).arrivals()) {
      await arrival.drop();
      break;
    }
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual([new Uint8Array([1])]);
  });

  it("is picked up until the signal aborts", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    for (const fill of [1, 2]) expect((await postTo(transport.data.url, new Uint8Array([fill]))).status).toBe(204);
    const controller = new AbortController();
    const ciphertexts: Uint8Array[] = [];
    for await (const arrival of (await services.pickup(mailbox, actor)).arrivals(controller.signal)) {
      ciphertexts.push(arrival.ciphertext);
      controller.abort();
    }
    expect(ciphertexts).toEqual([new Uint8Array([1])]);
  });

  it("whose service refuses a pickup throws what the service said", async () => {
    const earlier = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const { store, services, offer } = await withAccount(actorSigningBy(laptop, earlier));
    const { mailbox } = await openMailbox(store, offer, actorSigningBy(laptop, earlier));
    const later = await publish(wallet, { prior: earlier, agents: [laptop.key], at: 2_000 });
    await openMailbox(store, offer, actorSigningBy(laptop, later), keyOf(8));
    await expect(pickUpAll(await services.pickup(mailbox, actorSigningBy(phone, earlier)))).rejects.toThrow(
      /answered 403: .+is not honored/,
    );
  });

  it("is picked up by an agent that the root lists, once a later identity version takes out the key that opened it", async () => {
    const earlier = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const { store, services, offer } = await withAccount(actorSigningBy(laptop, earlier));
    const { transport, mailbox } = await openMailbox(store, offer, actorSigningBy(laptop, earlier));
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    const later = await publish(wallet, { prior: earlier, agents: [phone.key], at: 2_000 });
    await openMailbox(store, offer, actorSigningBy(phone, later), keyOf(8));
    expect(await pickUpAll(await services.pickup(mailbox, actorSigningBy(phone, later)))).toEqual([
      new Uint8Array([1]),
    ]);
  });

  it("is picked up where its service is, though an acknowledgement at its send id and key, of a request by a key taken out, came in at a mailbox", async () => {
    const earlier = await publish(wallet, { agents: [laptop.key, phone.key], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, agents: [phone.key], at: 2_000 });
    const actor = actorSigningBy(phone, later);
    const { store, services, offer } = await withAccount(actor);
    const before = await inboundRowsOf(store);
    const { transport, mailbox } = await openMailbox(store, offer, actor);
    expect((await postTo(transport.data.url, new Uint8Array([1]))).status).toBe(204);
    const [[acknowledgement] = []] = (await inboundRowsOf(store)).filter(
      ([link]) => !before.some(([held]) => held === link),
    );
    assert.exists(acknowledgement);
    const sendId = new URL(transport.data.url).pathname.slice(1);
    let other: Bundle;
    let at = 1;
    do {
      other = await mailboxAcknowledgementBy(
        await actorOf(mallory),
        actorSigningBy(laptop, earlier),
        mallory,
        sendId,
        at++,
      );
    } while (other.link >= acknowledgement);
    await receiveAtMailbox(store, other);
    expect(await pickUpAll(await services.pickup(mailbox, actor))).toEqual([new Uint8Array([1])]);
  });

  it("is not picked up for another identifier than the one whose request opened it", async () => {
    const actor = await actorOf(alice);
    const { store, services, offer } = await withAccount(actor);
    const { mailbox } = await openMailbox(store, offer, actor);
    await expect(pickUpAll(await services.pickup(mailbox, await actorOf(bob)))).rejects.toThrow(
      /answered 403: the request is signed for another identifier/,
    );
  });

  it("is not picked up when the store has no record of opening it", async () => {
    const { origin } = await startService();
    const { store, services } = client();
    await services.fetch(origin);
    const mailbox = await writeMailbox(store, `${origin}/${"0".repeat(32)}`);
    await expect(services.pickup(mailbox.link, await actorOf(alice))).rejects.toThrow(/has no record of opening/);
  });
});

/**
 * The bundle of `by`'s signature over an acknowledgement from `at`, at
 * `sendId`, of `requester`'s request for a mailbox for `keyOf(7)` by an offer
 * that names `offerer` by its identifier, with its closure.
 */
async function mailboxAcknowledgementBy(by: Actor, requester: Actor, offerer: Signer, sendId: string, at = 1) {
  const root = keys.encode(offerer.key);
  const mailboxOffer = encodeObject(mailboxOfferSchema, { identity: new LinkValue(root.link), ...terms });
  const request = encodeObject(mailboxRequestSchema, { offer: new LinkValue(mailboxOffer.link), key: keyOf(7) });
  const requestSignature = await requester.sign(request);
  const acknowledgement = encodeObject(mailboxAcknowledgementSchema, {
    request: new LinkValue(requestSignature.link),
    at,
    sendId: hex.decode(sendId),
    pickupId: hex.decode("2".repeat(32)),
  });
  const signature = await by.sign(acknowledgement);
  const blobs = [
    acknowledgement.bytes,
    ...mailboxAcknowledgementSchema.blobs,
    ...requestSignature.blobs,
    request.bytes,
    ...mailboxRequestSchema.blobs,
    mailboxOffer.bytes,
    ...mailboxOfferSchema.blobs,
    ...root.blobs,
  ];
  return decodeBundle(encodeBundle(signature.link, [...signature.blobs, ...blobs]));
}

describe("a mailbox acknowledgement that came in at a mailbox", () => {
  const sendId = "1".repeat(32);

  /**
   * A client whose store holds the Service of a running service, a mailbox
   * at `sendId` there for `keyOf(7)`, and `acknowledgement`, which came in at
   * that mailbox.
   */
  async function clientHolding(acknowledgement: Bundle) {
    const { origin } = await startService();
    const { store, services } = client();
    await services.fetch(origin);
    const mailbox = await writeMailbox(store, `${origin}/${sendId}`);
    await new Intake(store).receive(acknowledgement, mailbox);
    return { services, mailbox };
  }

  it.each<[string, (account: Actor, other: Actor) => Promise<readonly [by: Actor, requester: Actor, offerer: Signer]>]>(
    [
      [
        "the service signed it of the account's request",
        async (account) => [await serviceActor(1_000), account, serviceSigner],
      ],
      ["someone else signed it of their own request, for their own offer", async (_, other) => [other, other, mallory]],
      ["someone else signed it of the account's request", async (account, other) => [other, account, serviceSigner]],
    ],
  )("does not open the mailbox for the account to pick up, though %s", async (_, partiesOf) => {
    const account = await actorOf(alice);
    const [by, requester, offerer] = await partiesOf(account, await actorOf(mallory));
    const { services, mailbox } = await clientHolding(await mailboxAcknowledgementBy(by, requester, offerer, sendId));
    await expect(services.pickup(mailbox.link, account)).rejects.toThrow(/has no record of opening/);
  });
});
