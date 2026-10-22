import { encodeObject, encodeSchema, type EncodedObject, type JsonObject, type Schema, type SchemaValidator } from "@estoc/object";
import { hex } from "@scure/base";
import { mailboxSchema, type Transport } from "../src/index.ts";

/** Faults a network puts in the way of every message, as a real channel may. */
export interface Faults {
  /** Every sealed message arrives twice. */
  readonly twice?: boolean;
  /** `take` hands out the latest arrival first. */
  readonly reversed?: boolean;
  /** Whether the nth delivery on the network, counting from 0, is lost without a word. */
  readonly lost?: (n: number) => boolean;
}

/** A queue on a memory network, under a name the network made up. */
export interface Queue {
  readonly name: string;
  /** A mailbox at this queue, sealed to `key`. */
  mailbox(key: Uint8Array): EncodedObject;
  /** The sealed messages that have arrived since the last take, which leave the queue. */
  take(): Uint8Array[];
}

/**
 * A post office in one process: senders and receivers that share it reach
 * one another through its transport. A queue's name is 128 random bits, so
 * a mailbox taken to another network names no queue there, rather than
 * someone else's.
 */
export class MemoryNetwork {
  readonly transport: Transport;
  readonly #schema: Schema;
  readonly #faults: Faults;
  readonly #queues = new Map<string, Uint8Array[]>();
  #deliveries = 0;

  private constructor(schema: Schema, faults: Faults) {
    this.#schema = schema;
    this.#faults = faults;
    this.transport = { schema, deliver: async (mailbox, sealed) => this.#deliver(mailbox, sealed) };
  }

  static async create(validator: SchemaValidator, faults: Faults = {}): Promise<MemoryNetwork> {
    const schema = mailboxSchema("Memory mailbox", { name: { type: "string" } }, ["name"]);
    return new MemoryNetwork(await encodeSchema(schema, validator), faults);
  }

  queue(): Queue {
    const name = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
    const arrived: Uint8Array[] = [];
    this.#queues.set(name, arrived);
    return {
      name,
      mailbox: (key) => encodeObject(this.#schema, { key: hex.encode(key), name }),
      take: () => {
        const taken = arrived.splice(0);
        return this.#faults.reversed ? taken.reverse() : taken;
      },
    };
  }

  #deliver({ name }: JsonObject, sealed: Uint8Array): void {
    const arrived = typeof name === "string" ? this.#queues.get(name) : undefined;
    if (arrived === undefined) throw new Error(`no queue is named ${String(name)}`);
    if (this.#faults.lost?.(this.#deliveries++)) return;
    // Copied, so that what the sender does with its bytes afterwards does not reach the queue.
    arrived.push(sealed.slice());
    if (this.#faults.twice) arrived.push(sealed.slice());
  }
}
