import type { KeyObject, Signature } from "@estoc/identity";
import { type Link, linkOf } from "@estoc/object";
import type { MailboxTerms } from "./schemas.ts";

/** A mailbox that a service opened under an account. */
export interface OpenMailbox {
  /** The link of the signature over the request that opened it. */
  readonly request: Link<Signature>;
  /** The link of the service's signature over the acknowledgement of the request, which a pickup names. */
  readonly acknowledgement: Link<Signature>;
  /** The root of the identity whose account it is opened under, whose identities pick up there. */
  readonly root: Link<KeyObject>;
  /** The id that senders post to. */
  readonly sendId: string;
  /** The id that the account picks up at. */
  readonly pickupId: string;
  /** The terms of the offer that opened it. */
  readonly terms: MailboxTerms;
}

/**
 * The mailboxes that a service opened, and the ciphertexts that wait at
 * each, by its send id. When the service receives them, and which of them
 * still count, is the service's to say: what was received before `since`
 * no longer waits.
 */
export interface Mailboxes {
  /** Keeps `mailbox` unless one is kept for its request, in one step, and resolves to the one kept. */
  open(mailbox: OpenMailbox): Promise<OpenMailbox>;
  /** The mailbox that the request `request` opened, or `undefined` when none is kept. */
  mailboxOpenedBy(request: Link<Signature>): Promise<OpenMailbox | undefined>;
  /** The mailbox whose send id or pickup id is `id`, or `undefined` when none is kept. */
  mailboxNamed(id: string): Promise<OpenMailbox | undefined>;
  /**
   * Keeps `ciphertext`, received `at`, waiting at the mailbox `sendId`,
   * unless the bytes that wait there and it would come to more than `quota`,
   * in one step. A ciphertext that waits already waits once. Resolves to
   * whether it waits.
   */
  put(
    sendId: string,
    ciphertext: Uint8Array,
    limits: { readonly at: number; readonly since: number; readonly quota: number },
  ): Promise<boolean>;
  /** Lets the ciphertexts that `receipts` names no longer wait at the mailbox `sendId`. */
  drop(sendId: string, receipts: readonly Link<Uint8Array>[]): Promise<void>;
  /** The ciphertexts that wait at the mailbox `sendId`, the earliest first. */
  queue(sendId: string, since: number): AsyncIterable<Uint8Array>;
}

type QueueEntry = { readonly ciphertext: Uint8Array; readonly at: number };

/** Keeps mailboxes in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryMailboxes implements Mailboxes {
  readonly #byRequest = new Map<Link<Signature>, OpenMailbox>();
  readonly #byId = new Map<string, OpenMailbox>();
  readonly #queues = new Map<string, Map<Link<Uint8Array>, QueueEntry>>();

  async open(mailbox: OpenMailbox): Promise<OpenMailbox> {
    const kept = this.#byRequest.get(mailbox.request);
    if (kept !== undefined) return kept;
    this.#byRequest.set(mailbox.request, mailbox);
    this.#byId.set(mailbox.sendId, mailbox).set(mailbox.pickupId, mailbox);
    this.#queues.set(mailbox.sendId, new Map());
    return mailbox;
  }

  async mailboxOpenedBy(request: Link<Signature>): Promise<OpenMailbox | undefined> {
    return this.#byRequest.get(request);
  }

  async mailboxNamed(id: string): Promise<OpenMailbox | undefined> {
    return this.#byId.get(id);
  }

  async put(
    sendId: string,
    ciphertext: Uint8Array,
    { at, since, quota }: { readonly at: number; readonly since: number; readonly quota: number },
  ): Promise<boolean> {
    const queue = this.#removeExpired(sendId, since);
    const link = linkOf(ciphertext);
    if (queue.has(link)) return true;
    let bytes = ciphertext.length;
    for (const held of queue.values()) bytes += held.ciphertext.length;
    if (bytes > quota) return false;
    queue.set(link, { ciphertext: ciphertext.slice(), at });
    return true;
  }

  async drop(sendId: string, receipts: readonly Link<Uint8Array>[]): Promise<void> {
    const queue = this.#queues.get(sendId);
    for (const link of receipts) queue?.delete(link);
  }

  async *queue(sendId: string, since: number): AsyncIterable<Uint8Array> {
    for (const { ciphertext } of [...this.#removeExpired(sendId, since).values()]) yield ciphertext.slice();
  }

  #removeExpired(sendId: string, since: number): Map<Link<Uint8Array>, QueueEntry> {
    const queue = this.#queues.get(sendId);
    if (queue === undefined) throw new Error(`no mailbox is opened at ${sendId}`);
    for (const [link, { at }] of queue) if (at < since) queue.delete(link);
    return queue;
  }
}
