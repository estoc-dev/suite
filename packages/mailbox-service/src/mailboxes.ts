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
  readonly send: string;
  /** The id that the account picks up at. */
  readonly pickup: string;
  /** The terms of the offer that opened it. */
  readonly terms: MailboxTerms;
}

/**
 * The mailboxes that a service opened, and the sealed bytes that wait at
 * each, by its send id. When the service receives them, and which of them
 * still count, is the service's to say: what was received before `since`
 * no longer waits.
 */
export interface Mailboxes {
  /** Keeps `mailbox` unless one is kept for its request, in one step, and resolves to the one kept. */
  open(mailbox: OpenMailbox): Promise<OpenMailbox>;
  /** The mailbox that the request `request` opened, or `undefined` when none is kept. */
  openedBy(request: Link<Signature>): Promise<OpenMailbox | undefined>;
  /** The mailbox whose send id or pickup id is `id`, or `undefined` when none is kept. */
  named(id: string): Promise<OpenMailbox | undefined>;
  /**
   * Keeps `sealed`, received `at`, waiting at the mailbox `send`, unless
   * the bytes that wait there and it would come to more than `quota`, in
   * one step. Sealed bytes that wait already wait once. Resolves to whether
   * they wait.
   */
  put(
    send: string,
    sealed: Uint8Array,
    limits: { readonly at: number; readonly since: number; readonly quota: number },
  ): Promise<boolean>;
  /** Lets the sealed bytes that `done` names no longer wait at the mailbox `send`. */
  drop(send: string, done: readonly Link<Uint8Array>[]): Promise<void>;
  /** The sealed bytes that wait at the mailbox `send`, the earliest first. */
  waiting(send: string, since: number): AsyncIterable<Uint8Array>;
}

type Held = { readonly sealed: Uint8Array; readonly at: number };

/** Keeps mailboxes in memory, for tests and for a service that keeps nothing once it ends. */
export class MemoryMailboxes implements Mailboxes {
  readonly #opened = new Map<Link<Signature>, OpenMailbox>();
  readonly #named = new Map<string, OpenMailbox>();
  readonly #waiting = new Map<string, Map<Link<Uint8Array>, Held>>();

  async open(mailbox: OpenMailbox): Promise<OpenMailbox> {
    const kept = this.#opened.get(mailbox.request);
    if (kept !== undefined) return kept;
    this.#opened.set(mailbox.request, mailbox);
    this.#named.set(mailbox.send, mailbox).set(mailbox.pickup, mailbox);
    this.#waiting.set(mailbox.send, new Map());
    return mailbox;
  }

  async openedBy(request: Link<Signature>): Promise<OpenMailbox | undefined> {
    return this.#opened.get(request);
  }

  async named(id: string): Promise<OpenMailbox | undefined> {
    return this.#named.get(id);
  }

  async put(
    send: string,
    sealed: Uint8Array,
    { at, since, quota }: { readonly at: number; readonly since: number; readonly quota: number },
  ): Promise<boolean> {
    const waiting = this.#queue(send, since);
    const link = linkOf(sealed);
    if (waiting.has(link)) return true;
    let bytes = sealed.length;
    for (const held of waiting.values()) bytes += held.sealed.length;
    if (bytes > quota) return false;
    waiting.set(link, { sealed: sealed.slice(), at });
    return true;
  }

  async drop(send: string, done: readonly Link<Uint8Array>[]): Promise<void> {
    const waiting = this.#waiting.get(send);
    for (const link of done) waiting?.delete(link);
  }

  async *waiting(send: string, since: number): AsyncIterable<Uint8Array> {
    for (const { sealed } of [...this.#queue(send, since).values()]) yield sealed.slice();
  }

  #queue(send: string, since: number): Map<Link<Uint8Array>, Held> {
    const waiting = this.#waiting.get(send);
    if (waiting === undefined) throw new Error(`no mailbox is opened at ${send}`);
    for (const [link, { at }] of waiting) if (at < since) waiting.delete(link);
    return waiting;
  }
}
