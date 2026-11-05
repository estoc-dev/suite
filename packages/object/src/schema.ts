import { decodeBlob, type Encoding, type Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";

/** Lists what in the data of an object does not fit a schema; an empty list means it fits. */
export type Check<D> = (data: Fields<D>) => readonly string[];

/**
 * A language of schemas over the data of one encoding, as JSON Schema is
 * over JSON, with documents `S`.
 *
 * - A schema is an object written to what the language names by `link`: the root of a standard
 *   language, which describes itself, or a schema whose objects are schemas, as each key scheme is
 *   the schema of its keys. Changing language is changing what schemas are written to.
 * - A schema links to nothing but what it is written to, so that its closure is itself and the
 *   language's `blobs`.
 * - `document` reads a schema's data as the language takes it. A language written to a schema
 *   reads the data with that schema; one written to a root reads it itself, since no schema reads
 *   a root, as an encoding is told by the caller rather than by a blob.
 */
export interface SchemaLanguage<D, S> {
  /** The encoding of the schemas, and so of the objects written to them. */
  readonly encoding: Encoding<D>;
  /** What the schemas of the language are written to. */
  readonly link: Link<unknown>;
  /** The bytes of what the schemas are written to, and of all it links to, which go wherever a schema goes. */
  readonly blobs: readonly Uint8Array[];
  /** The data of the schema whose document is `document`. */
  data(document: S): Fields<D>;
  /**
   * The document of the schema whose data is `data`.
   *
   * @throws when `data` is not that of a schema of the language.
   */
  document(data: Fields<D>): S;
}

/**
 * Compiles the documents of one language into checks. A signature commits
 * to bytes and a validator is one reading of them, so a stricter validator
 * can replace another without any blob changing. Where the validators of a
 * language differ is theirs to decide; every validator works offline and
 * keeps to three rules:
 *
 * - A reference to anything outside the document fails compilation, rather
 *   than the validation that reaches it, so that the link of a schema fixes
 *   all that its data is checked against.
 * - The same document and value give the same answer every time.
 * - A version of the language it does not support fails compilation.
 */
export interface SchemaValidator<D, S> {
  readonly language: SchemaLanguage<D, S>;
  /** @throws when `document` cannot be compiled. */
  compile(document: S): Promise<Check<D>>;
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
  /**
   * The schema's closure, which goes wherever it goes: its bytes and the blobs of its language, as
   * a schema links to nothing but what it is written to.
   */
  readonly blobs: readonly Uint8Array[];
  readonly #check: Check<D>;

  constructor(
    language: SchemaLanguage<D, unknown>,
    { bytes, link }: { readonly bytes: Bytes<Schema<D>>; readonly link: Link<Schema<D>> },
    check: Check<D>,
  ) {
    this.encoding = language.encoding;
    this.bytes = bytes;
    this.link = link;
    this.blobs = [bytes, ...language.blobs];
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
 * @throws when the bytes are not an object written to what the validator's language names, or
 * hold anything but the data of a schema of the language.
 * @throws when the schema links to anything but what it is written to.
 * @throws when the validator cannot compile the document.
 */
export async function decodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  bytes: Bytes<Schema<D>>,
  validator: SchemaValidator<D, S>,
): Promise<Schema<D, F>> {
  const { language } = validator;
  const { encoding } = language;
  const { value, bytes: owned, link } = decodeBlob(encoding, bytes);
  const { data, schema } = encoding.fields(value);
  if (schema !== language.link)
    throw new Error(`a schema of this language is written to ${language.link}, not to ${schema ?? "itself"}`);
  for (const linked of encoding.links(value))
    if (linked !== language.link) throw new Error(`a schema links only to what it is written to, not to ${linked}`);
  return new Schema<D, F>(language, { bytes: owned, link }, await validator.compile(language.document(data)));
}

/** Writes `document` as a schema, and compiles it as `decodeSchema` does. */
export async function encodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  document: S,
  validator: SchemaValidator<D, S>,
): Promise<Schema<D, F>> {
  const { language } = validator;
  const { encoding } = language;
  return decodeSchema<D, S, F>(encoding.encode(encoding.object(language.data(document), language.link)), validator);
}
