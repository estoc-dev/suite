import { type Bytes, type Link, linkOf } from "./link.ts";
import { decodeObject } from "./object.ts";
import { itself, ObjectValue, objectFormat, type ValueMap } from "./object-format.ts";

export type Check = (data: ValueMap) => readonly string[];

/**
 * The root schema a schema names says which language it is in, so two languages do not read each
 * other's schemas.
 */
export interface SchemaLanguage<S> {
  readonly root: S;
  data(document: S): ValueMap;
  document(data: ValueMap): S;
}

/**
 * A check answers from the document and the data alone, so the link of a schema fixes all that its
 * data is checked against. A signature commits to the bytes and a validator is one reading of them,
 * so a stricter validator can replace another without any blob changing.
 */
export interface SchemaValidator<S> {
  readonly language: SchemaLanguage<S>;
  compile(document: S): Check;
}

export class Schema<F extends ValueMap = ValueMap> {
  readonly bytes: Bytes<Schema>;
  readonly link: Link<Schema>;
  readonly blobs: readonly Bytes<Schema>[];
  readonly #check: Check;

  constructor(
    { bytes, link }: { readonly bytes: Bytes<Schema>; readonly link: Link<Schema> },
    check: Check,
    root?: Schema,
  ) {
    this.bytes = bytes;
    this.link = link;
    this.blobs = root === undefined ? [bytes] : [bytes, ...root.blobs];
    this.#check = check;
  }

  validate(data: ValueMap): F {
    const problems = this.#check(data);
    if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
    return data as F;
  }
}

// A root schema is compiled once for each validator, and every schema read with the validator is
// written to that one.
const rootSchemas = new WeakMap<object, unknown>();

export function rootSchemaOf<S>(validator: SchemaValidator<S>): Schema {
  const held = rootSchemas.get(validator) as Schema | undefined;
  if (held !== undefined) return held;
  const { language } = validator;
  const data = language.data(language.root);
  const bytes = objectFormat.encode(new ObjectValue(itself, data));
  const root = new Schema({ bytes, link: linkOf(bytes) }, validator.compile(language.document(data)));
  root.validate(data);
  rootSchemas.set(validator, root);
  return root;
}

/**
 * A schema whose data holds a link is refused, so that the closure of a schema is the schema and
 * its root schema.
 */
export function decodeSchema<S, F extends ValueMap = ValueMap>(
  bytes: Bytes<Schema>,
  validator: SchemaValidator<S>,
): Schema<F> {
  const { language } = validator;
  const root = rootSchemaOf(validator);
  const blob: Uint8Array = bytes;
  const { link: objectLink, data } = decodeObject(blob, root);
  const link = objectLink as Link<unknown> as Link<Schema>;
  if (link === root.link) return root as Schema<F>;
  for (const linked of objectFormat.links(new ObjectValue(root.link, data))) {
    if (linked !== root.link) throw new Error(`a schema links to its root schema alone, not to ${linked}`);
  }
  const check = validator.compile(language.document(data));
  return new Schema<F>({ bytes: blob, link }, check, root);
}

export function encodeSchema<S, F extends ValueMap = ValueMap>(document: S, validator: SchemaValidator<S>): Schema<F> {
  const { language } = validator;
  const object = new ObjectValue(rootSchemaOf(validator).link, language.data(document));
  return decodeSchema<S, F>(objectFormat.encode(object), validator);
}
