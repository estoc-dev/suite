import {
  decodeObject,
  isValueMap,
  itself,
  type Link,
  LinkValue,
  type ObjectValue,
  objectFormat,
  type Reader,
  type Schema,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { rootSchema, type SchemaDocument, schemaLanguage, schemaValidator } from "@estoc/schema";

/** A link in the data of an object. */
export interface DataLink {
  /** Where in the data the link is, spelled as the validator spells the place of a problem: `#/replies/0`. */
  readonly path: string;
  readonly link: Link<unknown>;
}

/**
 * The schema an object names, as far as it could be read.
 *
 * - `absent`: the reader gives no blob for it.
 * - `refused`: the blob it names is not a schema of Estoc Schema, and `error` says why.
 * - `schema`: its document, and what in the data of the object does not fit it, each with its place.
 *   No problems means the data fits.
 */
export type NamedSchema =
  | { readonly kind: "absent"; readonly link: Link<unknown> }
  | { readonly kind: "refused"; readonly link: Link<unknown>; readonly error: unknown }
  | {
      readonly kind: "schema";
      readonly link: Link<Schema>;
      readonly document: SchemaDocument;
      readonly problems: readonly string[];
    };

/**
 * What a link reads as from one reader, by what the blob says of itself.
 *
 * - `absent`: the reader gives no blob for the link.
 * - `bytes`: the blob is not an object of the object format, and links to nothing.
 * - `object`: its data, each link in its data with its place, and the schema it names. The links
 *   come as walking `data` meets them, and the schema is not among them.
 */
export type Inspection =
  | { readonly kind: "absent"; readonly link: Link<unknown> }
  | { readonly kind: "bytes"; readonly link: Link<unknown>; readonly bytes: Uint8Array }
  | {
      readonly kind: "object";
      readonly link: Link<unknown>;
      readonly bytes: Uint8Array;
      readonly data: ValueMap;
      readonly links: readonly DataLink[];
      readonly schema: NamedSchema;
    };

/**
 * Reads the blob that `link` names from `reader`, by the schema the blob itself names.
 *
 * - A program that reads an object names the schema it expects, as `readObject` does. This reads
 *   whatever is there, so all it gives is what the blob says of itself: a title is the one its
 *   schema gave itself, and data that fits says only that its shape is right. Whose the object is,
 *   and whether a signature verifies, is for the program to say.
 * - Each step stops on its own, and what was read before it is still given. The fields of an object
 *   are read without its schema, since the object format marks the type of every value.
 * - Following a link of the object is inspecting it through the same reader.
 *
 * @throws what `reader` throws when it cannot give the blob of `link`, or of the schema the object
 * names. `absent` says the reader has no blob, and not that reading one failed.
 */
export async function inspect(link: Link<unknown>, reader: Reader): Promise<Inspection> {
  const bytes = await reader.get(link);
  if (bytes === undefined) return { kind: "absent", link };
  let object: ObjectValue;
  try {
    object = objectFormat.decode(bytes);
  } catch {
    return { kind: "bytes", link, bytes };
  }
  const schema =
    object.schema === itself
      ? namedSchema(link, bytes, object.data)
      : namedSchema(object.schema, await reader.get(object.schema), object.data);
  return { kind: "object", link, bytes, data: object.data, links: Array.from(linksAt(object.data, "#")), schema };
}

function namedSchema(link: Link<unknown>, bytes: Uint8Array | undefined, data: ValueMap): NamedSchema {
  if (bytes === undefined) return { kind: "absent", link };
  try {
    const document = schemaLanguage.document(decodeObject(bytes, rootSchema).data);
    return { kind: "schema", link: link as Link<Schema>, document, problems: schemaValidator.compile(document)(data) };
  } catch (error) {
    return { kind: "refused", link, error };
  }
}

function* linksAt(value: Value, path: string): Generator<DataLink> {
  if (value instanceof LinkValue) yield { path, link: value.link };
  else if (Array.isArray(value))
    for (const [index, item] of (value as readonly Value[]).entries()) yield* linksAt(item, `${path}/${index}`);
  else if (isValueMap(value))
    for (const [name, member] of Object.entries(value)) yield* linksAt(member, `${path}/${name}`);
}
