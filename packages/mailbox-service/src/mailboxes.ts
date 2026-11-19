import { type Link, linkOf } from "@estoc/object";
import type { MailboxTerms } from "./schemas.ts";

export interface OpenMailbox {
  readonly request: Link<unknown>;
  readonly acknowledgement: Link<unknown>;
  readonly identifier: Link<unknown>;
  readonly sendId: string;
  readonly pickupId: string;
  readonly terms: MailboxTerms;
}

/**
 * When the service receives the ciphertexts, and which of them still count, is the service's to
 * say: what was received before `since` no longer waits.
 */
export interface Mailboxes {
  /** Keeps `mailbox` unless one is kept for its request, in one step, and resolves to the one kept. */
  open(mailbox: OpenMailbox): Promise<OpenMailbox>;
  mailboxOpenedBy(request: Link<unknown>): Promise<OpenMailbox | undefined>;
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
  drop(sendId: string, receipts: readonly Link<Uint8Array>[]): Promise<void>;
  queue(sendId: string, since: number): AsyncIterable<Uint8Array>;
}

type HeldMessage = { readonly ciphertext: Uint8Array; readonly at: number };

export class MemoryMailboxes implements Mailboxes {
  readonly #byRequest = new Map<Link<unknown>, OpenMailbox>();
  readonly #byId = new Map<string, OpenMailbox>();
  readonly #queues = new Map<string, Map<Link<Uint8Array>, HeldMessage>>();

  async open(mailbox: OpenMailbox): Promise<OpenMailbox> {
    const existingMailbox = this.#byRequest.get(mailbox.request);
    if (existingMailbox !== undefined) return existingMailbox;
    this.#byRequest.set(mailbox.request, mailbox);
    this.#byId.set(mailbox.sendId, mailbox).set(mailbox.pickupId, mailbox);
    this.#queues.set(mailbox.sendId, new Map());
    return mailbox;
  }

  async mailboxOpenedBy(request: Link<unknown>): Promise<OpenMailbox | undefined> {
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

  #removeExpired(sendId: string, since: number): Map<Link<Uint8Array>, HeldMessage> {
    const queue = this.#queues.get(sendId);
    if (queue === undefined) throw new Error(`no mailbox is opened at ${sendId}`);
    for (const [link, { at }] of queue) if (at < since) queue.delete(link);
    return queue;
  }
}
