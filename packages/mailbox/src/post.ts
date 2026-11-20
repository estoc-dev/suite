import type { Bundle } from "@estoc/bundle";
import type { Actor } from "@estoc/identity";
import { type Bytes, type EncodedObject, encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import { Intake, type PrivateStore, RefusedBatch, recordsOf, type SecretStore, type Store } from "@estoc/store";
import { Correspondence, type CorrespondenceIdentity } from "./correspondence.ts";
import { MailboxGrants } from "./grant.ts";
import { MailboxKey } from "./key.ts";
import { type Mailbox, mailboxFrom, type Options, readMailbox, type Transport } from "./mailbox.ts";
import type { Pickup } from "./pickup.ts";
import { type MailboxKeyData, mailboxKeySchema, outboundSchema } from "./schema.ts";

export interface PostOptions extends Options {
  readonly clock?: () => number;
}

export interface Delivery {
  readonly direction: "inbound" | "outbound";
  readonly bundle: Link<never>;
  readonly mailbox: Link<EncodedObject>;
  readonly at: number;
  readonly link: Link<EncodedObject>;
}

type MailboxBytes = { readonly bytes: Bytes<EncodedObject> };

export class Post {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #secretStore: SecretStore;
  readonly #transports: readonly Transport[];
  readonly #clock: () => number;
  readonly #intake: Intake;

  constructor(
    store: Store,
    privateStore: PrivateStore,
    secretStore: SecretStore,
    { transports, clock = Date.now }: PostOptions,
  ) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#secretStore = secretStore;
    this.#transports = transports;
    this.#clock = clock;
    this.#intake = new Intake(store, privateStore, clock);
  }

  correspondenceAs(actor: Actor, identity: CorrespondenceIdentity): Correspondence {
    const stores = { store: this.#store, privateStore: this.#privateStore };
    return new Correspondence(stores, this, actor, this.#clock, new MailboxGrants(identity), identity);
  }

  async outbox(mailbox: Link<EncodedObject>): Promise<Outbox> {
    const boundMailbox = await mailboxFrom(await this.#bytesAt(mailbox), { transports: this.#transports });
    return new Outbox(boundMailbox, this.#store, this.#privateStore, this.#clock);
  }

  /**
   * The mailbox is written to the store, then a record of it to the private store, and then its key
   * to the secret store, so a stop in between leaves at most a mailbox that nobody receives at.
   */
  async openInbox(makeMailbox: (publicKey: Uint8Array) => MailboxBytes | Promise<MailboxBytes>): Promise<Inbox> {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const key = await MailboxKey.fromSecretKey(secret);
    const { mailbox, data } = readMailbox((await makeMailbox(key.publicKey)).bytes, this.#transports);
    if (!key.hasPublicKey(data.key)) throw new Error("the mailbox made names another key than the one given");
    await this.#store.write({ roots: [mailbox.link], blobs: [mailbox.bytes, ...mailbox.schema.blobs] });
    await this.#privateStore.write(recordsOf([mailbox.link], this.#clock()));
    const object = encodeObject(mailboxKeySchema, { mailbox: new LinkValue(mailbox.link), secret });
    await this.#secretStore.write({ secrets: [object.link], blobs: [object.bytes, ...mailboxKeySchema.blobs] });
    return this.#inbox(mailbox, object.link, key);
  }

  async inbox(key: Link<EncodedObject<MailboxKeyData>>): Promise<Inbox> {
    const { data } = await readObject(this.#secretStore, key, mailboxKeySchema);
    const { mailbox, data: mailboxData } = readMailbox(await this.#bytesAt(data.mailbox.link), this.#transports);
    const opener = await MailboxKey.fromSecretKey(data.secret);
    if (!opener.hasPublicKey(mailboxData.key)) throw new Error(`${mailbox.link} names another key than ${key} holds`);
    return this.#inbox(mailbox, key, opener);
  }

  #inbox(mailbox: EncodedObject, key: Link<EncodedObject<MailboxKeyData>>, opener: MailboxKey) {
    return new Inbox(mailbox, key, opener, this.#intake);
  }

  async #bytesAt(link: Link<unknown>): Promise<Uint8Array> {
    const bytes = await this.#store.get(link);
    if (bytes === undefined) throw new Error(`the store does not hold ${link}`);
    return bytes;
  }
}

export class Outbox {
  readonly #mailbox: Mailbox;
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #clock: () => number;

  constructor(mailbox: Mailbox, store: Store, privateStore: PrivateStore, clock: () => number) {
    this.#mailbox = mailbox;
    this.#store = store;
    this.#privateStore = privateStore;
    this.#clock = clock;
  }

  get mailbox(): Link<EncodedObject> {
    return this.#mailbox.link;
  }

  async send(root: Link<unknown>): Promise<Delivery> {
    await this.#mailbox.send(root, (await this.#store.closure(root)).values());
    const { mailbox } = this;
    const bundle = root as Link<never>;
    const at = this.#clock();
    const mark = encodeObject(outboundSchema, { bundle: new LinkValue(bundle), mailbox: new LinkValue(mailbox), at });
    await this.#privateStore.write({ marks: [mark.link], blobs: [mark.bytes, ...outboundSchema.blobs] });
    return { direction: "outbound", bundle, mailbox, at, link: mark.link };
  }
}

export class Inbox {
  readonly key: Link<EncodedObject<MailboxKeyData>>;
  readonly #mailbox: EncodedObject;
  readonly #opener: MailboxKey;
  readonly #intake: Intake;

  constructor(mailbox: EncodedObject, key: Link<EncodedObject<MailboxKeyData>>, opener: MailboxKey, intake: Intake) {
    this.#mailbox = mailbox;
    this.key = key;
    this.#opener = opener;
    this.#intake = intake;
  }

  get mailbox(): Link<EncodedObject> {
    return this.#mailbox.link;
  }

  async receive(ciphertext: Uint8Array): Promise<Delivery> {
    return this.#keep(await this.#opener.open(ciphertext));
  }

  /**
   * What does not open, and a bundle that the store refuses, are done with and leave no mark,
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
