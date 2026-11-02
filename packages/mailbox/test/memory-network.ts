import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  type JsonSchemaValidator,
  type Link,
  type Schema,
} from "@estoc/object";
import { hex } from "@scure/base";
import { type Arrival, mailboxSchema, type Pickup, type Transport, UndeliveredMessage } from "../src/index.ts";

/** Faults a network puts in the way of every message, as a real channel may. */
export interface Faults {
  /** Every sealed message arrives twice. */
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
  mailbox(key: Uint8Array): EncodedObject<Json>;
  /**
   * What waits at this queue, for a mailbox of it, until a receiver is done
   * with it. Refuses a mailbox that is not at this queue.
   */
  pickup(mailbox: Link<EncodedObject<Json>>): Pickup;
  /** The sealed messages that wait, which leave the queue. */
  take(): Uint8Array[];
  /** The one sealed message that waits, which leaves the queue; throws unless exactly one does. */
  takeOne(): Uint8Array;
}

type Waiting = { readonly sealed: Uint8Array };

/**
 * A post office in one process: senders and receivers that share it reach
 * one another through its transport. A queue's name is 128 random bits, so
 * a mailbox taken to another network names no queue there, rather than
 * someone else's.
 */
export class MemoryNetwork {
  readonly transport: Transport;
  readonly #schema: Schema<Json>;
  readonly #faults: Faults;
  readonly #queues = new Map<string, Waiting[]>();
  #deliveries = 0;
  #dones = 0;

  private constructor(schema: Schema<Json>, faults: Faults) {
    this.#schema = schema;
    this.#faults = faults;
    this.transport = { schema, deliver: async (mailbox, sealed) => this.#deliver(mailbox, sealed) };
  }

  static async create(validator: JsonSchemaValidator, faults: Faults = {}): Promise<MemoryNetwork> {
    const schema = mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]);
    return new MemoryNetwork(await encodeSchema(schema, validator), faults);
  }

  queue(): Queue {
    const name = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
    const waiting: Waiting[] = [];
    const mailboxes = new Set<Link<EncodedObject<Json>>>();
    this.#queues.set(name, waiting);
    const take = () => {
      const taken = waiting.splice(0).map(({ sealed }) => sealed);
      return this.#faults.reversed ? taken.reverse() : taken;
    };
    return {
      name,
      mailbox: (key) => {
        const mailbox = encodeObject(this.#schema, { key: hex.encode(key), name });
        mailboxes.add(mailbox.link);
        return mailbox;
      },
      pickup: (mailbox) => {
        if (!mailboxes.has(mailbox)) throw new Error(`${mailbox} is not a mailbox at ${name}`);
        return { mailbox, arrivals: (signal) => this.#arrivals(waiting, signal) };
      },
      take,
      takeOne: () => {
        const taken = take();
        const [sealed] = taken;
        if (sealed === undefined || taken.length > 1) throw new Error(`${taken.length} messages arrived, not one`);
        return sealed;
      },
    };
  }

  // Finds the next that waits each time, so what arrives meanwhile is
  // handed out too.
  async *#arrivals(waiting: Waiting[], signal?: AbortSignal): AsyncGenerator<Arrival> {
    const handed = new Set<Waiting>();
    for (;;) {
      if (signal?.aborted) return;
      const left = waiting.filter((each) => !handed.has(each));
      const next = this.#faults.reversed ? left.at(-1) : left[0];
      if (next === undefined) return;
      handed.add(next);
      yield { sealed: next.sealed.slice(), drop: async () => this.#drop(waiting, next) };
    }
  }

  #drop(waiting: Waiting[], arrival: Waiting): void {
    if (this.#faults.cut?.(this.#dones++)) throw new Error("the network was cut before the queue heard it was done");
    const at = waiting.indexOf(arrival);
    if (at !== -1) waiting.splice(at, 1);
  }

  #deliver({ name }: JsonObject, sealed: Uint8Array): void {
    const waiting = typeof name === "string" ? this.#queues.get(name) : undefined;
    if (waiting === undefined) throw new UndeliveredMessage("gone", `no queue is named ${String(name)}`);
    if (this.#faults.lost?.(this.#deliveries++)) return;
    // Copied, so that what the sender does with its bytes afterwards does not reach the queue.
    waiting.push({ sealed: sealed.slice() });
    if (this.#faults.twice) waiting.push({ sealed: sealed.slice() });
  }
}
