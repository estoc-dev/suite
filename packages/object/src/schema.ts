import { type Encoding, type Fields, itself } from "./encoding.ts";
import { type Bytes, type Link, linkOf } from "./link.ts";
import { decodeObject } from "./object.ts";

/** Lists what in the data of an object does not fit a schema; an empty list means it fits. */
export type Check<D> = (data: Fields<D>) => readonly string[];

/**
 * A language of schemas over the data of one encoding, with documents `S`.
 *
 * - A schema is an object: its data is its document, written to the root schema of its language.
 * - The root schema is written to itself, and says what the data of every schema of the language
 *   holds, its own included. What else makes a document one of the language is the language's to
 *   check, as whether a signature verifies is the program's and not its schema's.
 * - The root schema a schema names says which language it is in, so two languages over one
 *   encoding do not read each other's schemas.
 */
export interface SchemaLanguage<D, S> {
  /** The encoding of the schemas, and so of the objects written to them. */
  readonly encoding: Encoding<D>;
  /** The document of the root schema. */
  readonly root: S;
  /** The data of the schema whose document is `document`. */
  data(document: S): Fields<D>;
  /**
   * The document of the schema that holds `data`.
   *
   * @throws when `data` is not that of a schema of the language.
   */
  document(data: Fields<D>): S;
}

/**
 * Compiles the documents of one language into checks.
 *
 * - A check answers from the document and the data alone. A schema links to its root schema and
 *   nothing else, and compiling and checking wait for nothing, so the link of a schema fixes all
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
 * where it gets the schema, as in `const note: Schema<Value, Note> =
 * encodeSchema(…)`, and only data that fits the schema is handed out as one.
 */
export class Schema<D, F extends Fields<D> = Fields<D>> {
  /** The encoding of the objects written to this schema, which is that of its language. */
  readonly encoding: Encoding<D>;
  readonly bytes: Bytes<Schema<D>>;
  readonly link: Link<Schema<D>>;
  /**
   * The closure of the schema: its bytes and those of the root schema it is written to, or its
   * bytes alone when it is the root schema. They go wherever an object written to the schema goes.
   */
  readonly blobs: readonly Bytes<Schema<D>>[];
  readonly #check: Check<D>;

  /** `root` is the root schema that this one is written to, and is left out for the root schema itself. */
  constructor(
    encoding: Encoding<D>,
    { bytes, link }: { readonly bytes: Bytes<Schema<D>>; readonly link: Link<Schema<D>> },
    check: Check<D>,
    root?: Schema<D>,
  ) {
    this.encoding = encoding;
    this.bytes = bytes;
    this.link = link;
    this.blobs = root === undefined ? [bytes] : [bytes, ...root.blobs];
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

// A root schema is compiled once for each validator, and every schema read with the validator is
// written to that one.
const rootSchemas = new WeakMap<object, unknown>();

/**
 * The root schema of the validator's language, compiled by the validator: the schema that every
 * schema of the language is written to, itself included.
 *
 * @throws when the data of the root schema does not fit the root schema, or is not a document of
 * the language.
 */
export function rootSchemaOf<D, S>(validator: SchemaValidator<D, S>): Schema<D> {
  const held = rootSchemas.get(validator) as Schema<D> | undefined;
  if (held !== undefined) return held;
  const { language } = validator;
  const { encoding } = language;
  const data = language.data(language.root);
  const bytes = encoding.encode(encoding.object(data, itself));
  const root = new Schema<D>(encoding, { bytes, link: linkOf(bytes) }, validator.compile(language.document(data)));
  root.validate(data);
  rootSchemas.set(validator, root);
  return root;
}

/**
 * Reads the schema that `bytes` hold, and compiles its document with `validator`.
 *
 * @throws when the bytes are not an object written to the root schema of the validator's language,
 * or their data does not fit that root schema.
 * @throws when the data holds a link, so that the closure of a schema is the schema and its root
 * schema.
 * @throws when the data is not a document of the language.
 * @throws when the validator cannot compile the document.
 */
export function decodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  bytes: Bytes<Schema<D>>,
  validator: SchemaValidator<D, S>,
): Schema<D, F> {
  const { language } = validator;
  const root = rootSchemaOf(validator);
  const blob: Uint8Array = bytes;
  const { bytes: owned, link: objectLink, data } = decodeObject(blob, root);
  const link = objectLink as Link<unknown> as Link<Schema<D>>;
  if (link === root.link) return root as Schema<D, F>;
  const { encoding } = language;
  for (const linked of encoding.links(encoding.object(data, root.link))) {
    if (linked !== root.link) throw new Error(`a schema links to its root schema alone, not to ${linked}`);
  }
  const check = validator.compile(language.document(data));
  return new Schema<D, F>(encoding, { bytes: owned as Uint8Array, link }, check, root);
}

/** Writes `document` as a schema, and compiles it as `decodeSchema` does. */
export function encodeSchema<D, S, F extends Fields<D> = Fields<D>>(
  document: S,
  validator: SchemaValidator<D, S>,
): Schema<D, F> {
  const { language } = validator;
  const { encoding } = language;
  const value = encoding.object(language.data(document), rootSchemaOf(validator).link);
  return decodeSchema<D, S, F>(encoding.encode(value), validator);
}
