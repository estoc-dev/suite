import type { Bundle } from "@estoc/bundle";
import type { Actor } from "@estoc/identity";
import {
  type Bytes,
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  readObject,
  schemaOf,
} from "@estoc/object";
import { secretSchema } from "@estoc/schema";
import { Intake, RefusedBatch, type Store, scan, writtenObjectsOf } from "@estoc/store";
import { Correspondence, type CorrespondenceIdentity } from "./correspondence.ts";
import { MailboxGrants } from "./grant.ts";
import { heldMailboxKeys } from "./held-mailbox-keys.ts";
import { MailboxKey } from "./key.ts";
import { type Mailbox, mailboxAt, type Options, type Transport } from "./mailbox.ts";
import type { Pickup } from "./pickup.ts";
import { type MailboxData, type MailboxKeyData, mailboxKeySchema, mailboxSchema, outboundSchema } from "./schema.ts";

export interface PostOptions extends Options {
  readonly clock?: () => number;
}

export interface Delivery {
  readonly direction: "inbound" | "outbound";
  readonly bundle: Link<never>;
  readonly mailbox: Link<EncodedObject<MailboxData>>;
  readonly at: number;
  readonly link: Link<EncodedObject>;
}

type TransportBytes = { readonly bytes: Bytes<EncodedObject> };

export class Post {
  readonly #store: Store;
  readonly #transports: readonly Transport[];
  readonly #clock: () => number;
  readonly #intake: Intake;

  constructor(store: Store, { transports, clock = Date.now }: PostOptions) {
    this.#store = store;
    this.#transports = transports;
    this.#clock = clock;
    this.#intake = new Intake(store, clock);
  }

  correspondenceAs(actor: Actor, identity: CorrespondenceIdentity): Correspondence {
    return new Correspondence(this.#store, this, actor, this.#clock, new MailboxGrants(identity), identity);
  }

  async outbox(mailbox: Link<EncodedObject<MailboxData>>): Promise<Outbox> {
    const boundMailbox = await mailboxAt(mailbox, this.#store, { transports: this.#transports });
    return new Outbox(boundMailbox, this.#store, this.#clock);
  }

  async openInbox(makeTransport: (publicKey: Uint8Array) => TransportBytes | Promise<TransportBytes>): Promise<Inbox> {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await MailboxKey.fromSecretKey(secretKey);
    const { bytes } = await makeTransport(key.publicKey);
    const named = schemaOf(bytes);
    const transport = this.#transports.find(({ schema }) => schema.link === named);
    if (transport === undefined) throw new Error(`no transport takes ${named}`);
    const transportObject = decodeObject(bytes, transport.schema);
    const mailbox = encodeObject(mailboxSchema, {
      key: key.publicKey,
      transport: new LinkValue(transportObject.link),
    });
    const secret = encodeObject(secretSchema, { bytes: secretKey });
    const object = encodeObject(mailboxKeySchema, {
      mailbox: new LinkValue(mailbox.link),
      secret: new LinkValue(secret.link),
    });
    // The key is recorded first, so that a recorded mailbox has its key recorded wherever the
    // writes are cut short.
    await this.#store.record({
      statements: [object.link],
      blobs: [
        object.bytes,
        ...mailboxKeySchema.blobs,
        secret.bytes,
        ...secretSchema.blobs,
        mailbox.bytes,
        ...mailboxSchema.blobs,
        transportObject.bytes,
        ...transport.schema.blobs,
      ],
    });
    await this.#store.record(writtenObjectsOf([mailbox.link], this.#clock()));
    return this.#inbox(mailbox, object.link, key);
  }

  /**
   * Anyone can send a Mailbox Key and its Secret in a bundle, so an inbox opens only by a Mailbox
   * Key among the records of the store.
   */
  async inbox(key: Link<EncodedObject<MailboxKeyData>>): Promise<Inbox> {
    for await (const { data } of (await scan(this.#store, heldMailboxKeys)).range([new LinkValue(key)])) {
      const mailbox = await readObject(this.#store, data.mailbox.link, mailboxSchema);
      const secret = await readObject(this.#store, data.secret.link, secretSchema);
      const opener = await MailboxKey.fromSecretKey(secret.data.bytes);
      if (!opener.hasPublicKey(mailbox.data.key))
        throw new Error(`${mailbox.link} names another key than ${key} holds`);
      return this.#inbox(mailbox, key, opener);
    }
    throw new Error(`${key} is not a Mailbox Key among the records of the store`);
  }

  #inbox(mailbox: EncodedObject<MailboxData>, key: Link<EncodedObject<MailboxKeyData>>, opener: MailboxKey) {
    return new Inbox(mailbox, key, opener, this.#intake);
  }
}

export class Outbox {
  readonly #mailbox: Mailbox;
  readonly #store: Store;
  readonly #clock: () => number;

  constructor(mailbox: Mailbox, store: Store, clock: () => number) {
    this.#mailbox = mailbox;
    this.#store = store;
    this.#clock = clock;
  }

  get mailbox(): Link<EncodedObject<MailboxData>> {
    return this.#mailbox.link;
  }

  async send(root: Link<unknown>): Promise<Delivery> {
    await this.#mailbox.send(root, (await this.#store.closure(root)).values());
    const { mailbox } = this;
    const bundle = root as Link<never>;
    const at = this.#clock();
    const outbound = encodeObject(outboundSchema, {
      bundle: new LinkValue(bundle),
      mailbox: new LinkValue(mailbox),
      at,
    });
    await this.#store.record({ statements: [outbound.link], blobs: [outbound.bytes, ...outboundSchema.blobs] });
    return { direction: "outbound", bundle, mailbox, at, link: outbound.link };
  }
}

export class Inbox {
  readonly key: Link<EncodedObject<MailboxKeyData>>;
  readonly #mailbox: EncodedObject<MailboxData>;
  readonly #opener: MailboxKey;
  readonly #intake: Intake;

  constructor(
    mailbox: EncodedObject<MailboxData>,
    key: Link<EncodedObject<MailboxKeyData>>,
    opener: MailboxKey,
    intake: Intake,
  ) {
    this.#mailbox = mailbox;
    this.key = key;
    this.#opener = opener;
    this.#intake = intake;
  }

  get mailbox(): Link<EncodedObject<MailboxData>> {
    return this.#mailbox.link;
  }

  async receive(ciphertext: Uint8Array): Promise<Delivery> {
    return this.#keep(await this.#opener.open(ciphertext));
  }

  /**
   * What does not open, and a bundle that the store refuses, are done with and leave no record,
   * rather than wait for the blobs a bundle leaves out to reach the store.
   */
  async collect(pickup: Pickup, signal?: AbortSignal): Promise<Delivery[]> {
    if (pickup.mailbox !== this.mailbox)
      throw new Error(`a pickup of ${pickup.mailbox} is not collected at ${this.mailbox}`);
    const deliveries: Delivery[] = [];
    for await (const arrival of pickup.arrivals(signal)) {
      const delivery = await this.#tryReceive(arrival.ciphertext);
      if (delivery !== undefined) deliveries.push(delivery);
      await arrival.drop();
    }
    return deliveries;
  }

  async #tryReceive(ciphertext: Uint8Array): Promise<Delivery | undefined> {
    let bundle: Bundle;
    try {
      bundle = await this.#opener.open(ciphertext);
    } catch {
      return undefined;
    }
    try {
      return await this.#keep(bundle);
    } catch (error) {
      if (error instanceof RefusedBatch) return undefined;
      throw error;
    }
  }

  async #keep(bundle: Bundle): Promise<Delivery> {
    const { link, data } = await this.#intake.receive(bundle, this.#mailbox);
    return { direction: "inbound", bundle: bundle.link, mailbox: this.mailbox, at: data.at, link };
  }
}
