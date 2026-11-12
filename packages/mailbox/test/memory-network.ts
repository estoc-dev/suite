import { type EncodedObject, type Est, type EstMap, encodeObject, type Link } from "@estoc/object";
import { string } from "@estoc/schema";
import { hex } from "@scure/base";
import { type Arrival, mailboxSchema, type Pickup, type Transport, UndeliveredMessage } from "../src/index.ts";

/** Faults a network puts in the way of every message, as a real channel may. */
export interface Faults {
  /** Every ciphertext arrives twice. */
  readonly twice?: boolean;
  /** `take` and a pickup hand out the latest arrival first. */
  readonly reversed?: boolean;
  /** Whether the nth delivery on the network, counting from 0, is lost without a word. */
  readonly lost?: (n: number) => boolean;
  /**
   * Whether the nth arrival that a receiver is done with on the network,
   * counting from 0, is cut off before the queue hears of it, so that it
   * still waits there.
   */
  readonly cut?: (n: number) => boolean;
}

/** A queue on a memory network, under a name the network made up. */
export interface Queue {
  readonly name: string;
  /** A mailbox at this queue, sealed to `key`. */
  mailbox(key: Uint8Array): EncodedObject<Est>;
  /**
   * What waits at this queue, for a mailbox of it, until a receiver is done
   * with it. Refuses a mailbox that is not at this queue.
   */
  pickup(mailbox: Link<EncodedObject<Est>>): Pickup;
  /** The ciphertexts that wait, which leave the queue. */
  take(): Uint8Array[];
  /** The one ciphertext that waits, which leaves the queue; throws unless exactly one does. */
  takeOne(): Uint8Array;
}

type QueuedMessage = { readonly ciphertext: Uint8Array };

const schema = mailboxSchema("Memory mailbox", { name: string() });

/**
 * A post office in one process: senders and receivers that share it reach
 * one another through its transport. A queue's name is 128 random bits, so
 * a mailbox taken to another network names no queue there, rather than
 * someone else's.
 */
export class MemoryNetwork {
  readonly transport: Transport;
  readonly #faults: Faults;
  readonly #queues = new Map<string, QueuedMessage[]>();
  #deliveries = 0;
  #dones = 0;

  constructor(faults: Faults = {}) {
    this.#faults = faults;
    this.transport = { schema, deliver: async (mailbox, ciphertext) => this.#deliver(mailbox, ciphertext) };
  }

  queue(): Queue {
    const name = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
    const waiting: QueuedMessage[] = [];
    const mailboxes = new Set<Link<EncodedObject<Est>>>();
    this.#queues.set(name, waiting);
    const take = () => {
      const takenCiphertexts = waiting.splice(0).map(({ ciphertext }) => ciphertext);
      return this.#faults.reversed ? takenCiphertexts.reverse() : takenCiphertexts;
    };
    return {
      name,
      mailbox: (key) => {
        const mailbox = encodeObject(schema, { key, name });
        mailboxes.add(mailbox.link);
        return mailbox;
      },
      pickup: (mailbox) => {
        if (!mailboxes.has(mailbox)) throw new Error(`${mailbox} is not a mailbox at ${name}`);
        return { mailbox, arrivals: (signal) => this.#arrivals(waiting, signal) };
      },
      take,
      takeOne: () => {
        const takenCiphertexts = take();
        const [ciphertext] = takenCiphertexts;
        if (ciphertext === undefined || takenCiphertexts.length > 1)
          throw new Error(`${takenCiphertexts.length} messages arrived, not one`);
        return ciphertext;
      },
    };
  }

  // Finds the next that waits each time, so what arrives meanwhile is
  // handed out too.
  async *#arrivals(waiting: QueuedMessage[], signal?: AbortSignal): AsyncGenerator<Arrival> {
    const handedArrivals = new Set<QueuedMessage>();
    for (;;) {
      if (signal?.aborted) return;
      const left = waiting.filter((each) => !handedArrivals.has(each));
      const next = this.#faults.reversed ? left.at(-1) : left[0];
      if (next === undefined) return;
      handedArrivals.add(next);
      yield { ciphertext: next.ciphertext.slice(), drop: async () => this.#drop(waiting, next) };
    }
  }

  #drop(waiting: QueuedMessage[], arrival: QueuedMessage): void {
    if (this.#faults.cut?.(this.#dones++)) throw new Error("the network was cut before the queue heard it was done");
    const at = waiting.indexOf(arrival);
    if (at !== -1) waiting.splice(at, 1);
  }

  #deliver({ name }: EstMap, ciphertext: Uint8Array): void {
    const waiting = typeof name === "string" ? this.#queues.get(name) : undefined;
    if (waiting === undefined) throw new UndeliveredMessage("gone", `no queue is named ${String(name)}`);
    if (this.#faults.lost?.(this.#deliveries++)) return;
    // Copied, so that what the sender does with its bytes afterwards does not reach the queue.
    waiting.push({ ciphertext: ciphertext.slice() });
    if (this.#faults.twice) waiting.push({ ciphertext: ciphertext.slice() });
  }
}
