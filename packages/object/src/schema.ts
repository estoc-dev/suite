import { decodeBlob, type Encoding, type Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";

/** Lists what in the data of an object does not fit a schema; an empty list means it fits. */
export type Check<D> = (data: Fields<D>) => readonly string[];

/**
 * A language of schemas `S` over the data of one encoding, as JSON Schema is
 * over JSON. A schema is a blob of its own, named by its link like any
 * other.
 */
export interface SchemaLanguage<D, S = unknown> {
  /** The encoding of the data that the schemas describe, and so of the objects written to them. */
  readonly encoding: Encoding<D>;
  /** @throws when the language cannot write `schema`. */
  encode(schema: S): Uint8Array;
  /**
   * Reads the schema that `bytes` hold.
   *
   * @throws when the bytes are not exactly what `encode` writes for that schema.
   */
  decode(bytes: Uint8Array): S;
  /** The schema that a program reading `schema` reads too: the earlier version it follows, if any. */
  predecessorOf(schema: S): Link<Schema<D>> | undefined;
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
export interface SchemaValidator<D, S> {
  readonly language: SchemaLanguage<D, S>;
  /** @throws when `schema` cannot be compiled. */
  compile(schema: S): Promise<Check<D>>;
}

/**
 * A schema as a blob, compiled by the validator it was read with. `F` is the
 * type the program reads the data written to it as. The program declares it
 * where it gets the schema, as in `const note: Schema<Json, Note> = await
 * encodeSchema(…)`, and only data that fits the schema is handed out as one.
 */
export class Schema<D, F extends Fields<D> = Fields<D>> {
  /** The encoding of the objects written to this schema, which is that of its language. */
  readonly encoding: Encoding<D>;
  readonly bytes: Bytes<Schema<D>>;
  readonly link: Link<Schema<D>>;
  /** The schema that a program reading this one reads too, as its language gives it. */
  readonly predecessor: Link<Schema<D>> | undefined;
  readonly #check: Check<D>;

  constructor(
    encoding: Encoding<D>,
    bytes: Bytes<Schema<D>>,
    link: Link<Schema<D>>,
    predecessor: Link<Schema<D>> | undefined,
    check: Check<D>,
  ) {
    this.encoding = encoding;
    this.bytes = bytes;
    this.link = link;
    this.predecessor = predecessor;
    this.#check = check;
  }

  /**
   * Gives back `data` as an `F`.
   *
   * @throws when `data` does not fit this schema, saying what does not fit.
   */
  validate(data: Fields<D>): F {
    const problems = this.#check(data);
    if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
    return data as F;
  }
}

export async function decodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  bytes: Bytes<Schema<D>>,
  validator: SchemaValidator<D, S>,
): Promise<Schema<D, F>> {
  const { language } = validator;
  const { value, bytes: owned, link } = decodeBlob(language, bytes);
  const predecessor = language.predecessorOf(value);
  return new Schema<D, F>(language.encoding, owned, link, predecessor, await validator.compile(value));
}

export async function encodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  schema: S,
  validator: SchemaValidator<D, S>,
): Promise<Schema<D, F>> {
  return decodeSchema<D, S, F>(validator.language.encode(schema), validator);
}
