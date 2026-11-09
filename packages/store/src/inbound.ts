import {
  type Bytes,
  DRAFT_2020_12,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonLink,
  type JsonSchema,
  type JsonSchemaValidator,
  type Link,
  linkSchema,
  type Schema,
} from "@estoc/object";
import type { Store } from "./store.ts";

/**
 * The draft 2020-12 schema of a record that a bundle came in from outside the store.
 *
 * - `bundle` is the link of the bundle's root.
 * - `at` is when, in milliseconds since the Unix epoch, by the clock of the device that wrote the
 *   record.
 * - `via` is the link of the channel it came in by, such as a mailbox, and is left out for what
 *   was handed over out of band. Which channel it is shows in the object it links to.
 */
export const inboundSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Inbound",
  type: "object",
  properties: { bundle: linkSchema, at: { type: "integer", minimum: 0 }, via: linkSchema },
  required: ["bundle", "at"],
  additionalProperties: false,
};

export type InboundData = {
  readonly bundle: JsonLink<never>;
  readonly at: number;
  readonly via?: JsonLink<EncodedObject<Json>>;
};

export type InboundObject = EncodedObject<Json, InboundData>;

/** What `Intake` keeps: the link of a root and the blobs that come with it. A `Bundle` of `@estoc/bundle` is one. */
export interface ReceivedBundle {
  readonly link: Link<never>;
  blobs(): Iterable<Bytes<unknown>>;
}

export interface IntakeOptions {
  /** The validator that the schema of the records is compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

/**
 * Keeps what comes from outside a store, with a record of `inboundSchema` that it came in.
 *
 * - The record says that it came in and nothing more: the store holds the closure of its root, and
 *   `at` is by this device's clock.
 * - A reader of the records verifies what it reads from them itself.
 */
export class Intake {
  readonly #store: Store;
  readonly #schema: Schema<Json, InboundData>;
  readonly #clock: () => number;

  constructor(store: Store, schema: Schema<Json, InboundData>, clock: () => number) {
    this.#store = store;
    this.#schema = schema;
    this.#clock = clock;
  }

  /**
   * Keeps `bundle` in one write with its record, which gives `via` as the channel when there is
   * one. What comes in twice is recorded twice, once for each time it came in.
   *
   * @throws {RefusedBatch} when the bundle leaves out a blob in its root's closure that the store
   *   does not hold, or the store does not hold `via`; nothing is kept then.
   */
  async receive(bundle: ReceivedBundle, via?: Link<EncodedObject<Json>>): Promise<InboundObject> {
    const data: InboundData = { bundle: { $link: bundle.link }, at: this.#clock() };
    const record = encodeObject(this.#schema, via === undefined ? data : { ...data, via: { $link: via } });
    await this.#store.write({ records: [record], blobs: [...this.#schema.blobs, ...bundle.blobs()] });
    return record;
  }
}

/** Makes an intake that keeps what comes from outside `store` in it. */
export async function loadIntake(store: Store, { validator, clock = Date.now }: IntakeOptions): Promise<Intake> {
  return new Intake(store, await encodeSchema(inboundSchema, validator), clock);
}
