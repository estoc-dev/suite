import { documentOf, problemsOf, type RootData, rootDocument, type SchemaDocument } from "./document.ts";
import { type Bytes, type Link, linkOf } from "./link.ts";
import { decodeObject } from "./object.ts";
import { itself, ObjectValue, objectFormat, type ValueMap } from "./object-format.ts";

export class Schema<F extends ValueMap = ValueMap> {
  readonly bytes: Bytes<Schema>;
  readonly link: Link<Schema>;
  readonly blobs: readonly Bytes<Schema>[];
  readonly document: SchemaDocument;

  constructor(
    { bytes, link }: { readonly bytes: Bytes<Schema>; readonly link: Link<Schema> },
    document: SchemaDocument,
    root?: Schema,
  ) {
    this.bytes = bytes;
    this.link = link;
    this.blobs = root === undefined ? [bytes] : [bytes, ...root.blobs];
    this.document = document;
  }

  problemsIn(data: ValueMap): string[] {
    return problemsOf(data, this.document);
  }

  validate(data: ValueMap): F {
    const problems = this.problemsIn(data);
    if (problems.length > 0) throw new Error(`the data does not fit its schema: ${problems.join("; ")}`);
    return data as F;
  }
}

const rootBytes = objectFormat.encode(new ObjectValue(itself, rootDocument));

export const rootSchema = new Schema<RootData>({ bytes: rootBytes, link: linkOf(rootBytes) }, rootDocument);

export function decodeSchema<F extends ValueMap = ValueMap>(bytes: Bytes<Schema>): Schema<F> {
  const blob: Uint8Array = bytes;
  const { link: objectLink, data } = decodeObject(blob, rootSchema);
  const link = objectLink as Link<unknown> as Link<Schema>;
  if (link === rootSchema.link) return rootSchema as Schema as Schema<F>;
  return new Schema<F>({ bytes: blob, link }, documentOf(data), rootSchema);
}

export function encodeSchema<F extends ValueMap = ValueMap>(document: SchemaDocument): Schema<F> {
  return decodeSchema<F>(objectFormat.encode(new ObjectValue(rootSchema.link, document)));
}
