import {
  type Actor,
  hasSigner,
  type IdentityKit,
  type IdentityVersion,
  type KeyObject,
  noIdentityVersions,
  type People,
  type Signature,
  type SignedIdentityObject,
} from "@estoc/identity";
import type { EncodedObject, Json, Link } from "@estoc/object";
import { indexOverBlobs, type Store, type View, view } from "@estoc/store";
import type { MailboxGrants } from "./grant.ts";
import { UndeliveredMessage } from "./mailbox.ts";
import type { Delivery, Post } from "./post.ts";

/** What of `@estoc/identity` a correspondence reads and signs with. */
export type CorrespondenceIdentity = Pick<IdentityKit, "signatures" | "signedIdentities" | "identityVersions">;

/**
 * Sending and reading as one actor, by the Mailbox Grants and the identity versions a store holds.
 *
 * - The store's grants and identity versions are read anew at each call, so what came in since
 *   counts.
 * - The indexes they are read through are made once, with the correspondence, so a store keeps
 *   their rows between scans.
 */
export class Correspondence {
  readonly #store: Store;
  readonly #post: Pick<Post, "outbox">;
  readonly #actor: Actor;
  readonly #root: Link<KeyObject>;
  readonly #clock: () => number;
  readonly #grants: MailboxGrants;
  readonly #signatures: CorrespondenceIdentity["signatures"];
  readonly #seenPeople: View<IdentityVersion, People>;

  constructor(
    store: Store,
    post: Pick<Post, "outbox">,
    actor: Actor,
    clock: () => number,
    grants: MailboxGrants,
    { signatures, identityVersions }: CorrespondenceIdentity,
  ) {
    this.#store = store;
    this.#post = post;
    this.#actor = actor;
    this.#root = actor.signedIdentity.identity.root.link;
    this.#clock = clock;
    this.#grants = grants;
    this.#signatures = signatures;
    this.#seenPeople = {
      index: indexOverBlobs(identityVersions.selection, (identityVersion) => [identityVersion]),
      read: (rows, reader) => identityVersions.people(rows, reader),
    };
  }

  /**
   * Signs a grant of `mailboxes` to `to`, and writes the signature as a record with its closure.
   * The grant is to the current identity version of `to` that the store holds, `to` itself when
   * none is later. Who the grant reaches, and how, is the caller's to choose.
   *
   * @throws {RefusedBatch} when the store does not hold one of `mailboxes`; nothing is written then.
   */
  async grant(to: SignedIdentityObject, mailboxes: readonly Link<EncodedObject<Json>>[]): Promise<Signature> {
    const current = await (await view(this.#store, this.#seenPeople)).current(to);
    const grant = this.#grants.encode(current, mailboxes, this.#clock());
    const signature = await this.#actor.sign(grant);
    await this.#store.write({
      records: [signature],
      blobs: [
        grant.bytes,
        ...this.#grants.schema.blobs,
        ...this.#signatures.schema.blobs,
        ...signature.signedIdentity.blobs,
        ...current.blobs,
      ],
    });
    return signature;
  }

  /**
   * Sends `root` and its closure in the store to each mailbox of the latest grant of `to`'s root
   * to the actor's root, and writes a record for each mailbox that takes it.
   *
   * - `to` takes messages at each of those mailboxes, so the message has gone once one takes it. A
   *   mailbox that turns it back leaves no record and does not stop the others.
   * - Sending a root again sends the same bundle and writes other records.
   *
   * @throws {UndeliveredMessage} of kind `gone` when the latest grant names no mailbox, or the store
   *   holds no grant that counts.
   * @throws {UndeliveredMessage} when every mailbox turned it back: one of kind `later` if there is
   *   one, as the same can be sent again later.
   * @throws when the post has no transport for one of the mailboxes; nothing is sent then.
   * @throws when the store does not hold `root`.
   */
  async send(to: SignedIdentityObject, root: Link<unknown>): Promise<Delivery[]> {
    const from = to.identity.root.link;
    const series = await view(this.#store, this.#grants.series);
    const grant = await series.grantFrom(from, this.#root, await view(this.#store, this.#seenPeople));
    const mailboxes = grant?.object.data.mailboxes ?? [];
    if (mailboxes.length === 0) throw new UndeliveredMessage("gone", `${from} grants ${this.#root} no mailbox`);
    const outboxes = await Promise.all(mailboxes.map(({ $link }) => this.#post.outbox($link)));
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
   * The signature at the root of `bundle`, which came in at `mailbox`, when it counts as a message
   * from whoever signed it.
   *
   * - The key that made it signs for the signer's current identity version.
   * - `mailbox` is in a grant of the actor's root to the signer's root, whose key signs for the
   *   actor's current identity version. An earlier grant counts as the latest does, so what came in
   *   before a move still reads as theirs.
   * - Anything else gives `undefined`, since anyone can send anything to a mailbox.
   *
   * @throws when the store fails to give a blob.
   */
  async messageAt(mailbox: Link<EncodedObject<Json>>, bundle: Link<never>): Promise<Signature | undefined> {
    const signature = await this.#signatureAtRootOf(bundle);
    if (signature === undefined) return undefined;
    const people = await view(this.#store, this.#seenPeople);
    const current = await people.current(signature.signedIdentity);
    if (!hasSigner(current.identity, signature.key)) return undefined;
    const series = await view(this.#store, this.#grants.series);
    const signer = signature.signedIdentity.identity.root.link;
    for await (const { object } of series.grantsFrom(this.#root, signer, people)) {
      if (object.data.mailboxes.some(({ $link }) => $link === mailbox)) return signature;
    }
    return undefined;
  }

  // The closure is read first, so that a store that fails is told apart from a bundle that does not read.
  async #signatureAtRootOf(bundle: Link<never>): Promise<Signature | undefined> {
    const closure = await this.#store.closure(bundle);
    try {
      return await this.#signatures.read(bundle, { get: (link) => closure.get(link) }, noIdentityVersions);
    } catch {
      return undefined;
    }
  }
}
