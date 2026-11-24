import type { Bundle } from "@estoc/bundle";
import { type EncodedObject, encodeObject, type Link } from "@estoc/object";
import { type DataOf, schema, string } from "@estoc/schema";
import { hex } from "@scure/base";
import {
  type Arrival,
  type MailboxData,
  type Pickup,
  type Route,
  type Transport,
  UndeliveredMessage,
} from "../src/index.ts";
import { mailboxBundle } from "./mailbox-bundle.ts";

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
  readonly transport: EncodedObject;
  /** A mailbox at this queue whose messages are sealed to `key`, as it is handed out on its own. */
  mailbox(key: Uint8Array): Bundle;
  /** What waits at this queue, for `mailbox`, until a receiver is done with it. */
  pickup(mailbox: Link<EncodedObject<MailboxData>>): Pickup;
  /** The ciphertexts that wait, which leave the queue. */
  take(): Uint8Array[];
  /** The one ciphertext that waits, which leaves the queue; throws unless exactly one does. */
  takeOne(): Uint8Array;
  /** From then on, a delivery to this queue is turned back as `kind`. */
  turnBack(kind: UndeliveredMessage["kind"]): void;
}

type QueuedMessage = { readonly ciphertext: Uint8Array };

interface QueueState {
  readonly waiting: QueuedMessage[];
  turnedBackAs?: UndeliveredMessage["kind"];
}

const transportSchema = schema("Memory transport", { name: string() });

/**
 * A post office in one process: senders and receivers that share it reach
 * one another through its transport. A queue's name is 128 random bits, so
 * a mailbox taken to another network names no queue there, rather than
 * someone else's.
 */
export class MemoryNetwork {
  readonly transport: Transport<DataOf<typeof transportSchema>>;
  readonly #faults: Faults;
  readonly #queues = new Map<string, QueueState>();
  #deliveries = 0;
  #dones = 0;

  constructor(faults: Faults = {}) {
    this.#faults = faults;
    this.transport = { schema: transportSchema, routeTo: ({ name }) => this.#routeTo(name) };
  }

  queue(): Queue {
    const name = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
    const state: QueueState = { waiting: [] };
    const { waiting } = state;
    const transport = encodeObject(transportSchema, { name });
    this.#queues.set(name, state);
    const take = () => {
      const takenCiphertexts = waiting.splice(0).map(({ ciphertext }) => ciphertext);
      return this.#faults.reversed ? takenCiphertexts.reverse() : takenCiphertexts;
    };
    return {
      name,
      transport,
      mailbox: (key) => mailboxBundle(key, transport),
      pickup: (mailbox) => ({ mailbox, arrivals: (signal) => this.#arrivals(waiting, signal) }),
      take,
      takeOne: () => {
        const takenCiphertexts = take();
        const [ciphertext] = takenCiphertexts;
        if (ciphertext === undefined || takenCiphertexts.length > 1)
          throw new Error(`${takenCiphertexts.length} messages arrived, not one`);
        return ciphertext;
      },
      turnBack: (kind) => {
        state.turnedBackAs = kind;
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

  #routeTo(name: string): Route {
    const state = this.#queues.get(name);
    if (state === undefined) throw new UndeliveredMessage("gone", `no queue is named ${name}`);
    return { deliver: async (ciphertext) => this.#deliver(state, ciphertext) };
  }

  #deliver({ waiting, turnedBackAs }: QueueState, ciphertext: Uint8Array): void {
    if (turnedBackAs !== undefined) throw new UndeliveredMessage(turnedBackAs, "the queue turns it back");
    if (this.#faults.lost?.(this.#deliveries++)) return;
    waiting.push({ ciphertext });
    if (this.#faults.twice) waiting.push({ ciphertext });
  }
}
