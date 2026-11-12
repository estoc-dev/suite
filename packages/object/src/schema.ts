import { decodeBlob, type Encoding, type Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";

/** Lists what in the data of an object does not fit a schema; an empty list means it fits. */
export type Check<D> = (data: Fields<D>) => readonly string[];

/**
 * A language of schemas over the data of one encoding, with documents `S`.
 *
 * - A schema is a value of the encoding that links to nothing. An object names it by link, and
 *   that alone makes the blob its schema.
 * - No blob says which language a schema is in, as none says which encoding some bytes are in:
 *   the program that reads a schema names the language.
 */
export interface SchemaLanguage<D, S> {
  /** The encoding of the schemas, and so of the objects written to them. */
  readonly encoding: Encoding<D>;
  /** The value that the schema whose document is `document` is written as. */
  value(document: S): D;
  /**
   * The document of the schema written as `value`.
   *
   * @throws when `value` is not a schema of the language.
   */
  document(value: D): S;
}

/**
 * Compiles the documents of one language into checks.
 *
 * - A check answers from the document and the data alone. A schema links to nothing, and
 *   compiling and checking wait for nothing, so in one language the link of a schema fixes all
 *   that its data is checked against.
 * - What fits a schema is the language's to say. Where a language leaves something to its
 *   validators, a signature commits to the bytes and a validator is one reading of them, so a
 *   stricter validator can replace another without any blob changing.
 */
export interface SchemaValidator<D, S> {
  readonly language: SchemaLanguage<D, S>;
  /** @throws when `document` cannot be compiled. */
  compile(document: S): Check<D>;
}

/**
 * A schema as a blob, compiled by the validator it was read with. `F` is the
 * type the program reads the data written to it as. The program declares it
 * where it gets the schema, as in `const note: Schema<Json, Note> =
 * encodeSchema(…)`, and only data that fits the schema is handed out as one.
 */
export class Schema<D, F extends Fields<D> = Fields<D>> {
  /** The encoding of the objects written to this schema, which is that of its language. */
  readonly encoding: Encoding<D>;
  /**
   * The schema as a blob, which is its whole closure, as a schema links to nothing. It goes
   * wherever an object written to the schema goes.
   */
  readonly bytes: Bytes<Schema<D>>;
  readonly link: Link<Schema<D>>;
  readonly #check: Check<D>;

  constructor(
    encoding: Encoding<D>,
    { bytes, link }: { readonly bytes: Bytes<Schema<D>>; readonly link: Link<Schema<D>> },
    check: Check<D>,
  ) {
    this.encoding = encoding;
    this.bytes = bytes;
    this.link = link;
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

/**
 * Reads the schema that `bytes` hold, and compiles its document with `validator`.
 *
 * @throws when the bytes link to another blob, as an object does to its schema.
 * @throws when the bytes do not hold a schema of the validator's language.
 * @throws when the validator cannot compile the document.
 */
export function decodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  bytes: Bytes<Schema<D>>,
  validator: SchemaValidator<D, S>,
): Schema<D, F> {
  const { language } = validator;
  const { encoding } = language;
  const { value, bytes: owned, link } = decodeBlob(encoding, bytes);
  const [linked] = encoding.links(value);
  if (linked !== undefined) throw new Error(`a schema links to nothing, not to ${linked}`);
  return new Schema<D, F>(encoding, { bytes: owned, link }, validator.compile(language.document(value)));
}

/** Writes `document` as a schema, and compiles it as `decodeSchema` does. */
export function encodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  document: S,
  validator: SchemaValidator<D, S>,
): Schema<D, F> {
  const { language } = validator;
  return decodeSchema<D, S, F>(language.encoding.encode(language.value(document)), validator);
}
