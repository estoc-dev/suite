import { type Actor, identityKit, type Signature, type SignedIdentityObject } from "@estoc/identity";
import type { EncodedObject, Link } from "@estoc/object";
import { peopleView, type SeenIdentityVersions } from "@estoc/people";
import { type Store, view, writtenObjectsOf } from "@estoc/store";
import type { MailboxGrants } from "./grant.ts";
import { UndeliveredMessage } from "./mailbox.ts";
import type { Delivery, Post } from "./post.ts";
import type { MailboxData } from "./schema.ts";
import { signedIdentityArrivalsView } from "./signed-identity-arrivals.ts";

export class Correspondence {
  readonly #store: Store;
  readonly #post: Pick<Post, "outbox">;
  readonly #actor: Actor;
  readonly #clock: () => number;
  readonly #grants: MailboxGrants;

  constructor(store: Store, post: Pick<Post, "outbox">, actor: Actor, clock: () => number, grants: MailboxGrants) {
    this.#store = store;
    this.#post = post;
    this.#actor = actor;
    this.#clock = clock;
    this.#grants = grants;
  }

  async grant(to: SignedIdentityObject, mailboxes: readonly Link<EncodedObject<MailboxData>>[]): Promise<Signature> {
    const current = await (await view(this.#store, peopleView)).current(to);
    const at = this.#clock();
    const grant = this.#grants.encode(current, mailboxes, at);
    const signature = await this.#actor.sign(grant);
    await this.#store.write({
      roots: [signature.link],
      blobs: [...signature.blobs, grant.bytes, ...this.#grants.schema.blobs, ...current.blobs],
    });
    await this.#store.record(writtenObjectsOf([signature.link], at));
    return signature;
  }

  async send(to: SignedIdentityObject, root: Link<unknown>): Promise<Delivery[]> {
    const from = to.identity.identifier;
    const series = await view(this.#store, this.#grants.series);
    const grant = await series.grantFrom(from, this.#actor.identifier, await this.#peopleAsOfArrival());
    const mailboxes = grant?.object.data.mailboxes ?? [];
    if (mailboxes.length === 0)
      throw new UndeliveredMessage("gone", `${from} grants ${this.#actor.identifier} no mailbox`);
    const deliveries: Delivery[] = [];
    const turnedBack: UndeliveredMessage[] = [];
    for (const { link } of mailboxes) {
      try {
        deliveries.push(await (await this.#post.outbox(link)).send(root));
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
    for await (const { object } of series.grantsFrom(this.#actor.identifier, signer, peopleAsOfArrival)) {
      if (object.data.mailboxes.some(({ link }) => link === mailbox)) return signature;
    }
    return undefined;
  }

  async #peopleAsOfArrival(): Promise<SeenIdentityVersions> {
    const people = await view(this.#store, peopleView);
    return people.asOfArrival(await view(this.#store, signedIdentityArrivalsView));
  }

  // The closure is read first, so that a store that fails is told apart from a bundle that does not read.
  async #signatureAtRootOf(bundle: Link<never>): Promise<Signature | undefined> {
    const closure = await this.#store.closure(bundle);
    try {
      return await identityKit.signatures.read(bundle, { get: (link) => closure.get(link) });
    } catch {
      return undefined;
    }
  }
}
