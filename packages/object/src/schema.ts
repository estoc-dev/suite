import { documentOf, rootDocument, type SchemaDocument } from "./document.ts";
import { type Bytes, type Link, linkOf } from "./link.ts";
import { decodeObject } from "./object.ts";
import { itself, ObjectValue, objectFormat, type ValueMap } from "./object-format.ts";

export type Check = (data: ValueMap) => readonly string[];

/**
 * A check answers from the document and the data alone, so the link of a schema fixes all that its
 * data is checked against. A signature commits to the bytes and a validator is one reading of them,
 * so a stricter validator can replace another without any blob changing.
 */
export interface SchemaValidator {
  compile(document: SchemaDocument): Check;
}

export class Schema<F extends ValueMap = ValueMap> {
  readonly bytes: Bytes<Schema>;
  readonly link: Link<Schema>;
  readonly blobs: readonly Bytes<Schema>[];
  readonly document: SchemaDocument;
  readonly #check: Check;

  constructor(
    { bytes, link }: { readonly bytes: Bytes<Schema>; readonly link: Link<Schema> },
    document: SchemaDocument,
    check: Check,
    root?: Schema,
  ) {
    this.bytes = bytes;
    this.link = link;
    this.blobs = root === undefined ? [bytes] : [bytes, ...root.blobs];
    this.document = document;
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
const rootSchemas = new WeakMap<SchemaValidator, Schema>();

export function rootSchemaOf(validator: SchemaValidator): Schema {
  const held = rootSchemas.get(validator);
  if (held !== undefined) return held;
  const bytes = objectFormat.encode(new ObjectValue(itself, rootDocument));
  const root = new Schema({ bytes, link: linkOf(bytes) }, rootDocument, validator.compile(rootDocument));
  root.validate(rootDocument);
  rootSchemas.set(validator, root);
  return root;
}

export function decodeSchema<F extends ValueMap = ValueMap>(
  bytes: Bytes<Schema>,
  validator: SchemaValidator,
): Schema<F> {
  const root = rootSchemaOf(validator);
  const blob: Uint8Array = bytes;
  const { link: objectLink, data } = decodeObject(blob, root);
  const link = objectLink as Link<unknown> as Link<Schema>;
  if (link === root.link) return root as Schema<F>;
  const document = documentOf(data);
  return new Schema<F>({ bytes: blob, link }, document, validator.compile(document), root);
}

export function encodeSchema<F extends ValueMap = ValueMap>(
  document: SchemaDocument,
  validator: SchemaValidator,
): Schema<F> {
  const object = new ObjectValue(rootSchemaOf(validator).link, document);
  return decodeSchema<F>(objectFormat.encode(object), validator);
}
