import type { Actor, IdentityKit, SeenIdentityVersions, Signature, SignedIdentityObject } from "@estoc/identity";
import type { EncodedObject, Link } from "@estoc/object";
import { type ArrivalsView, arrivalsView, type PrivateStore, recordsOf, type Store, view } from "@estoc/store";
import type { MailboxGrants } from "./grant.ts";
import { UndeliveredMessage } from "./mailbox.ts";
import { type PeopleView, peopleView } from "./people.ts";
import type { Delivery, Post } from "./post.ts";

export type CorrespondenceIdentity = Pick<IdentityKit, "signatures" | "signedIdentities" | "identityVersions">;

/**
 * The indexes it reads through are made once, with the correspondence, so a store keeps their rows
 * between scans.
 */
export class Correspondence {
  readonly #store: Store;
  readonly #privateStore: PrivateStore;
  readonly #post: Pick<Post, "outbox">;
  readonly #actor: Actor;
  readonly #identifier: Link<unknown>;
  readonly #clock: () => number;
  readonly #grants: MailboxGrants;
  readonly #signatures: CorrespondenceIdentity["signatures"];
  readonly #seenPeople: PeopleView;
  readonly #arrivals: ArrivalsView;

  constructor(
    { store, privateStore }: { readonly store: Store; readonly privateStore: PrivateStore },
    post: Pick<Post, "outbox">,
    actor: Actor,
    clock: () => number,
    grants: MailboxGrants,
    { signatures, signedIdentities, identityVersions }: CorrespondenceIdentity,
  ) {
    this.#store = store;
    this.#privateStore = privateStore;
    this.#post = post;
    this.#actor = actor;
    this.#identifier = actor.signedIdentity.identity.identifier;
    this.#clock = clock;
    this.#grants = grants;
    this.#signatures = signatures;
    this.#seenPeople = peopleView(identityVersions);
    this.#arrivals = arrivalsView(signedIdentities.schema);
  }

  async grant(to: SignedIdentityObject, mailboxes: readonly Link<EncodedObject>[]): Promise<Signature> {
    const current = await (await view(this.#store, this.#seenPeople)).current(to);
    const at = this.#clock();
    const grant = this.#grants.encode(current, mailboxes, at);
    const signature = await this.#actor.sign(grant);
    await this.#store.write({
      roots: [signature.link],
      blobs: [...signature.blobs, grant.bytes, ...this.#grants.schema.blobs, ...current.blobs],
    });
    await this.#privateStore.write(recordsOf([signature.link], at));
    return signature;
  }

  async send(to: SignedIdentityObject, root: Link<unknown>): Promise<Delivery[]> {
    const from = to.identity.identifier;
    const series = await view(this.#store, this.#grants.series);
    const grant = await series.grantFrom(from, this.#identifier, await this.#peopleAsOfArrival());
    const mailboxes = grant?.object.data.mailboxes ?? [];
    if (mailboxes.length === 0) throw new UndeliveredMessage("gone", `${from} grants ${this.#identifier} no mailbox`);
    const outboxes = await Promise.all(mailboxes.map(({ link }) => this.#post.outbox(link)));
    const deliveries: Delivery[] = [];
    const turnedBack: UndeliveredMessage[] = [];
    for (const outbox of outboxes) {
      try {
        deliveries.push(await outbox.send(root));
      } catch (error) {
        if (!(error instanceof UndeliveredMessage)) throw error;
        turnedBack.push(error);
      }
    }
    if (deliveries.length > 0) return deliveries;
    throw turnedBack.find(({ kind }) => kind === "later") ?? turnedBack[0];
  }

  /**
   * A message counts when its mailbox is in any grant of the actor to the signer that is honored,
   * not only the latest, so what came in before a move still reads as theirs.
   */
  async messageAt(mailbox: Link<EncodedObject>, bundle: Link<never>): Promise<Signature | undefined> {
    const signature = await this.#signatureAtRootOf(bundle);
    if (signature === undefined) return undefined;
    const peopleAsOfArrival = await this.#peopleAsOfArrival();
    if (!(await peopleAsOfArrival.honors(signature))) return undefined;
    const series = await view(this.#store, this.#grants.series);
    const signer = signature.signedIdentity.identity.identifier;
    for await (const { object } of series.grantsFrom(this.#identifier, signer, peopleAsOfArrival)) {
      if (object.data.mailboxes.some(({ link }) => link === mailbox)) return signature;
    }
    return undefined;
  }

  async #peopleAsOfArrival(): Promise<SeenIdentityVersions> {
    const people = await view(this.#store, this.#seenPeople);
    return people.asOfArrival(await view(this.#privateStore, this.#arrivals));
  }

  // The closure is read first, so that a store that fails is told apart from a bundle that does not read.
  async #signatureAtRootOf(bundle: Link<never>): Promise<Signature | undefined> {
    const closure = await this.#store.closure(bundle);
    try {
      return await this.#signatures.read(bundle, { get: (link) => closure.get(link) });
    } catch {
      return undefined;
    }
  }
}
