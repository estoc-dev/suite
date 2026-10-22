import { decodeBlob, type Encoding } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";

/** Lists what in a value does not fit a schema; an empty list means it fits. */
export type Check<D> = (data: D) => readonly string[];

/**
 * A language of schemas `S` over the data of one encoding, as JSON Schema is
 * over JSON. A schema is a blob of its own, named by its link like any
 * other.
 */
export interface SchemaLanguage<S, D> {
  /** The encoding of the data that the schemas describe, and so of the objects written to them. */
  readonly encoding: Encoding<D>;
  /** Throws for a schema the language cannot write. */
  encode(schema: S): Uint8Array;
  /** Reads bytes that are exactly what `encode` writes for the schema they hold, and refuses any other. */
  decode(bytes: Uint8Array): S;
}

/**
 * Compiles the schemas of one language into checks. A signature commits to
 * bytes and a validator is one reading of them, so a stricter validator can
 * replace another without any blob changing. Where the validators of a
 * language differ is theirs to decide; every validator works offline and
 * keeps to three rules:
 *
 * - A reference to anything outside the schema fails compilation, rather
 *   than the validation that reaches it, so that the link of a schema fixes
 *   all that its data is checked against.
 * - The same schema and value give the same answer every time.
 * - A version of the language it does not support fails compilation.
 */
export interface SchemaValidator<S, D> {
  readonly language: SchemaLanguage<S, D>;
  /** Rejects when the schema cannot be compiled. */
  compile(schema: S): Promise<Check<D>>;
}

/** A schema as a blob, compiled by the validator it was read with. */
export class Schema<D> {
  /** The encoding of the objects written to this schema, which is that of its language. */
  readonly encoding: Encoding<D>;
  readonly bytes: Bytes<Schema<D>>;
  readonly link: Link<Schema<D>>;
  readonly #check: Check<D>;

  constructor(encoding: Encoding<D>, bytes: Bytes<Schema<D>>, link: Link<Schema<D>>, check: Check<D>) {
    this.encoding = encoding;
    this.bytes = bytes;
    this.link = link;
    this.#check = check;
  }

  /** Lists what in `data` does not fit this schema; an empty list means it fits. */
  validate(data: D): readonly string[] {
    return this.#check(data);
  }
}

export async function decodeSchema<S, D>(bytes: Bytes<Schema<D>>, validator: SchemaValidator<S, D>): Promise<Schema<D>> {
  const { language } = validator;
  const { value, bytes: owned, link } = decodeBlob(language, bytes);
  return new Schema(language.encoding, owned, link, await validator.compile(value));
}

export async function encodeSchema<S, D>(schema: S, validator: SchemaValidator<S, D>): Promise<Schema<D>> {
  return decodeSchema(validator.language.encode(schema), validator);
}
