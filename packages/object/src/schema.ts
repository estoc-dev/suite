import { decodeBlob, type Encoding, type Fields } from "./encoding.ts";
import type { Bytes, Link } from "./link.ts";
import type { SelfDescribingObject } from "./object.ts";

/** Lists what in the data of an object does not fit a schema; an empty list means it fits. */
export type Check<D> = (data: Fields<D>) => readonly string[];

/**
 * A language of schemas over the data of one encoding, as JSON Schema is
 * over JSON, with documents `S`.
 *
 * - A schema is an object written to the language's root, which describes itself and stands for
 *   the language. Changing language is changing root.
 * - The data of a schema is its `document` alone, whole as the language writes it, so that the
 *   language's own tools read it as it is.
 * - No schema reads the root: what reads a schema checks the link it names, and reads the
 *   document out itself, as an encoding is told by the caller rather than by a blob.
 */
export interface SchemaLanguage<D, S extends D = D> {
  /** The encoding of the schemas, and so of the objects written to them. */
  readonly encoding: Encoding<D>;
  readonly root: SelfDescribingObject<D>;
  /**
   * Gives back `value` as a document of the language.
   *
   * @throws when it is not one.
   */
  document(value: D): S;
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
export interface SchemaValidator<D, S extends D = D> {
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
  readonly root: SelfDescribingObject<D>;
  readonly bytes: Bytes<Schema<D>>;
  readonly link: Link<Schema<D>>;
  /** The closure of the schema: its bytes and the root of its language, which go wherever it goes. */
  readonly blobs: readonly Uint8Array[];
  readonly #check: Check<D>;

  constructor(
    language: SchemaLanguage<D>,
    { bytes, link }: { readonly bytes: Bytes<Schema<D>>; readonly link: Link<Schema<D>> },
    check: Check<D>,
  ) {
    this.encoding = language.encoding;
    this.root = language.root;
    this.bytes = bytes;
    this.link = link;
    this.blobs = [bytes, language.root.bytes];
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
 * @throws when the bytes are not an object written to the root of the validator's language, or
 * hold anything but a document of the language.
 * @throws when the validator cannot compile the document.
 */
export async function decodeSchema<D, S extends D, F extends Fields<D> = Fields<D>>(
  bytes: Bytes<Schema<D>>,
  validator: SchemaValidator<D, S>,
): Promise<Schema<D, F>> {
  const { language } = validator;
  const { encoding, root } = language;
  const { value, bytes: owned, link } = decodeBlob(encoding, bytes);
  const { data, schema } = encoding.fields(value);
  if (schema !== root.link)
    throw new Error(`a schema is written to the root ${root.link}, not to ${schema ?? "itself"}`);
  const { document, ...rest } = data;
  if (document === undefined) throw new Error("a schema holds a document");
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new Error(`a schema holds a document alone, not ${extra.join(", ")}`);
  return new Schema<D, F>(language, { bytes: owned, link }, await validator.compile(language.document(document)));
}

/** Writes `document` as a schema, and compiles it as `decodeSchema` does. */
export async function encodeSchema<D, S extends D, F extends Fields<D> = Fields<D>>(
  document: S,
  validator: SchemaValidator<D, S>,
): Promise<Schema<D, F>> {
  const { encoding, root } = validator.language;
  return decodeSchema<D, S, F>(encoding.encode(encoding.object({ document }, root.link)), validator);
}
