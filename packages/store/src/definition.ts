import {
  type EncodedObject,
  encodeObject,
  type Field,
  type Item,
  type Link,
  LinkValue,
  memberOf,
  type Schema,
  type SchemaDocument,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { any, array, type DataOf, link, schema } from "@estoc/schema";
import type { ScannedBlob } from "./scanned-blob.ts";

/** Where there is a `memberSchema`, the path takes a value of an object written to it, and of no other. */
type Path =
  | { readonly take: "field"; readonly name: string; readonly memberSchema: Schema }
  | { readonly take: "link" | "schema"; readonly memberSchema: Schema | undefined };

/** Each path takes a value of a blob that the index the part is in reads, where the blob is an object. */
export interface PartDefinition {
  readonly paths: { readonly [rowField: string]: Path };
}

declare const end: unique symbol;

let pathOf: (valuePath: ValuePath<unknown>) => Path;

type FieldsHeldIn<F> = { [N in keyof F & string]-?: undefined extends F[N] ? never : N }[keyof F & string];

/** `F` holds the fields that the path can take: none where it does not say the schema of the object. */
export class ObjectPath<F extends ValueMap> {
  readonly #memberSchema: Schema<F> | undefined;

  constructor(memberSchema?: Schema<F>) {
    this.#memberSchema = memberSchema;
  }

  /**
   * What a row takes of a field that an object left out is not settled, so a path takes a field that
   * every object of the schema holds.
   */
  field<N extends FieldsHeldIn<F>>(name: N): ValuePath<F[N]> {
    if (this.#memberSchema === undefined)
      throw new Error(`a path takes the field ${name} of an object whose schema it does not say`);
    return new ValuePath({ take: "field", name, memberSchema: this.#memberSchema });
  }

  get link(): ValuePath<LinkValue<EncodedObject<F>>> {
    return new ValuePath({ take: "link", memberSchema: this.#memberSchema });
  }

  get schema(): ValuePath<LinkValue<Schema>> {
    return new ValuePath({ take: "schema", memberSchema: this.#memberSchema });
  }
}

export class ValuePath<T> {
  declare readonly [end]?: T;
  readonly #path: Path;

  static {
    pathOf = (valuePath) => valuePath.#path;
  }

  constructor(path: Path) {
    this.#path = path;
  }
}

/** Each blob that the index reads, where it is an object. */
export const anyMemberObject: ObjectPath<Record<never, never>> = new ObjectPath();

/** Each blob that the index reads, where it is an object written to `schema`. */
export function memberObjectOf<F extends ValueMap>(schema: Schema<F>): ObjectPath<F> {
  return new ObjectPath(schema);
}

export function partAlong(paths: { readonly [rowField: string]: ValuePath<unknown> }): PartDefinition {
  const taken = Object.entries(paths).map(([rowField, path]) => [rowField, pathOf(path)] as const);
  if (taken.length === 0) throw new Error("a part with no path reads nothing");
  return { paths: Object.fromEntries(taken) };
}

const nameOf = (type: Item): string => (type.type === "array" ? `array of ${nameOf(type.items)}` : type.type);

export const fieldOf = ({ fields }: SchemaDocument, name: string): Field | undefined =>
  Object.hasOwn(fields, name) ? fields[name] : undefined;

const typeOf = ({ optional: _, ...type }: Field): Item => type;

function typeTakenBy(path: Path, refuse: (reason: string) => never): Item {
  if (path.take !== "field") return { type: "link" };
  const { document } = path.memberSchema;
  const field = fieldOf(document, path.name);
  if (field === undefined) return refuse(`takes the field ${path.name}, which ${document.title} has not`);
  if (field.optional === true)
    return refuse(`takes the field ${path.name}, which an object of ${document.title} may leave out`);
  return typeOf(field);
}

function requirePathsToFit(rows: Schema, { paths }: PartDefinition): void {
  const rowDocument = rows.document;
  for (const name of Object.keys(rowDocument.fields))
    if (!Object.hasOwn(paths, name)) throw new Error(`no path is given for the field ${name} of ${rowDocument.title}`);
  for (const [name, path] of Object.entries(paths)) {
    const rowField = fieldOf(rowDocument, name);
    if (rowField === undefined) throw new Error(`a path is given for ${name}, which ${rowDocument.title} has not`);
    const refuse = (reason: string): never => {
      throw new Error(`the path of ${name} in ${rowDocument.title} ${reason}`);
    };
    const [type, rowType] = [nameOf(typeTakenBy(path, refuse)), nameOf(typeOf(rowField))];
    if (type !== rowType) refuse(`gives ${type}, and the row takes ${rowType}`);
  }
}

async function valueTakenBy(path: Path, blob: ScannedBlob, namedSchema: Link<Schema>): Promise<Value | undefined> {
  const data = path.memberSchema === undefined ? {} : (await blob.objectOf(path.memberSchema))?.data;
  if (data === undefined) return undefined;
  if (path.take === "field") return memberOf(data, path.name);
  return new LinkValue(path.take === "link" ? blob.link : namedSchema);
}

type Taken = readonly [rowField: string, value: Value | undefined];

const hasValue = (taken: Taken): taken is readonly [string, Value] => taken[1] !== undefined;

/** A path that does not fit the rows, or the schema it takes the object as, is refused before any blob is read. */
export function rowReaderOf(
  rows: Schema,
  definition: PartDefinition,
): (blob: ScannedBlob) => Promise<ValueMap | undefined> {
  requirePathsToFit(rows, definition);
  const paths = Object.entries(definition.paths);
  return async (blob) => {
    const namedSchema = await blob.namedSchema();
    if (namedSchema === undefined) return undefined;
    // Every path is taken before any of them is found to take nothing: where two paths take the
    // object as two schemas, one that names either and does not fit it fails whichever is given
    // first.
    const taken: Taken[] = [];
    for (const [rowField, path] of paths) taken.push([rowField, await valueTakenBy(path, blob, namedSchema)]);
    // A row may hold a field named `__proto__`, which assigning to an object would leave out.
    return taken.every(hasValue) ? Object.fromEntries(taken) : undefined;
  };
}

/**
 * - It says how rows come of the blobs that an index reads. Which blobs those are, what the rows are
 *   called and what they are ordered by are no part of it, so none of them changes its link.
 * - `rows` is the schema of the rows, and the rows are those that any part gives. A part gives a row
 *   of an object among the blobs, and its `paths` hold under each field of the row what the row
 *   takes of that object: `{ take: "field", name }` a field of it, `{ take: "link" }` its link, and
 *   `{ take: "schema" }` the link of the schema it is written to.
 * - `memberSchema` in a path is the link of the schema that the object is taken as. A path that
 *   takes a field has one, and the others may.
 * - An object gives a row where every path takes a value of it, and none where a path takes it as a
 *   schema that it is not written to. Where it names a schema that a path takes it as and does not
 *   fit it, the part fails on it.
 */
const indexDefinitionSchema = schema("Index Definition", { rows: link<Schema>(), parts: array(any()) });

export type IndexDefinition = EncodedObject<DataOf<typeof indexDefinitionSchema>>;

function pathValueOf({ memberSchema, ...taken }: Path): ValueMap {
  return memberSchema === undefined ? taken : { ...taken, memberSchema: new LinkValue(memberSchema.link) };
}

export function indexDefinitionOf(rows: Schema, parts: readonly PartDefinition[]): IndexDefinition {
  return encodeObject(indexDefinitionSchema, {
    rows: new LinkValue(rows.link),
    parts: parts.map(({ paths }) => ({
      paths: Object.fromEntries(Object.entries(paths).map(([rowField, path]) => [rowField, pathValueOf(path)])),
    })),
  });
}
