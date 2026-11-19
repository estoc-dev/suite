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

export interface DataLink {
  readonly path: string;
  readonly link: Link<unknown>;
}

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
 * The links of an object come as walking `data` meets them, which is not always the order of the
 * bytes: JavaScript lists a member named `10` before one named `a`.
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
 * This reads whatever is there, by the schema the blob names, so a title is the one its schema gave
 * itself and data that fits says only that its shape is right. Whose the object is, and whether a
 * signature verifies, is for the program to say.
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
