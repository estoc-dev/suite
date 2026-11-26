import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  memberOf,
  namedSchemaOf,
  type Schema,
  schemaOf,
  type Value,
  type ValueMap,
} from "@estoc/object";
import {
  any,
  array,
  type DataOf,
  type Field,
  type Item,
  link,
  rootSchema,
  type SchemaDocument,
  schema,
  schemaLanguage,
} from "@estoc/schema";
import { closureIn, linksIn } from "./batch.ts";
import { recordSchema } from "./record.ts";

type Step =
  | { readonly step: "field"; readonly name: string }
  | { readonly step: "link" }
  | { readonly step: "schema" }
  | { readonly step: "object"; readonly schema: Schema }
  | { readonly step: "eachLink" }
  | { readonly step: "eachInClosure" };

/**
 * A part reads the objects held that are written to `schema`, or every object held where it has
 * none. Each path starts at the object read.
 */
export interface PartDefinition {
  readonly schema?: Schema;
  readonly paths: { readonly [rowField: string]: readonly Step[] };
}

interface Route {
  readonly start: Schema | undefined;
  readonly steps: readonly Step[];
}

const routeWith = ({ start, steps }: Route, step: Step): Route => ({ start, steps: [...steps, step] });

declare const end: unique symbol;

let routeOf: (path: ValuePath<unknown>) => Route;

type FieldsHeldIn<F> = { [N in keyof F & string]-?: undefined extends F[N] ? never : N }[keyof F & string];

/** `F` holds the fields that the path can take: none where it does not say the schema of the object. */
export class ObjectPath<F extends ValueMap> {
  readonly #route: Route;

  constructor(route: Route) {
    this.#route = route;
  }

  /**
   * What a row takes of a field that an object left out is not settled, so a path takes a field that
   * every object of the schema holds.
   */
  field<N extends FieldsHeldIn<F>>(name: N): ValuePath<F[N]> {
    return new ValuePath(routeWith(this.#route, { step: "field", name }));
  }

  get link(): ValuePath<LinkValue<EncodedObject<F>>> {
    return new ValuePath(routeWith(this.#route, { step: "link" }));
  }

  get schema(): ValuePath<LinkValue<Schema>> {
    return new ValuePath(routeWith(this.#route, { step: "schema" }));
  }

  /** A row of each link that the object holds, the one to its schema among them. */
  eachLink(): ValuePath<LinkValue<unknown>> {
    return new ValuePath(routeWith(this.#route, { step: "eachLink" }));
  }
}

export class ValuePath<T> {
  declare readonly [end]?: T;
  readonly #route: Route;

  static {
    routeOf = (path) => path.#route;
  }

  constructor(route: Route) {
    this.#route = route;
  }

  /** Where the link leads to a blob that is not an object of `schema`, no row comes of it. */
  objectOf<F extends ValueMap>(this: ValuePath<LinkValue<unknown>>, schema: Schema<F>): ObjectPath<F> {
    return new ObjectPath(routeWith(this.#route, { step: "object", schema }));
  }

  /** A row of the link of each blob in the closure of the link, its own among them. */
  eachInClosure(this: ValuePath<LinkValue<unknown>>): ValuePath<LinkValue<unknown>> {
    return new ValuePath(routeWith(this.#route, { step: "eachInClosure" }));
  }
}

/**
 * An object held of any schema, what a stranger sent as well as the store's own. A scan reads
 * every blob it is over once for each index that reads this way.
 */
export const anyHeldObject: ObjectPath<Record<never, never>> = new ObjectPath({ start: undefined, steps: [] });

/**
 * - Anyone can send a bundle with an object of any schema in it, so an object read this way may be
 *   a stranger's, unless `schema` is that of a Record, which the store alone writes.
 * - A scan reads every blob it is over once for each index that reads this way. The Records are
 *   read once for all of them.
 */
export function heldObject<F extends ValueMap>(schema: Schema<F>): ObjectPath<F> {
  return new ObjectPath({ start: schema, steps: [] });
}

/**
 * A statement of `schema` that the store recorded. One of the same schema that only came to the
 * store, as in a bundle, is not one of these.
 */
export function recordedStatement<F extends ValueMap>(schema: Schema<F>): ObjectPath<F> {
  return heldObject(recordSchema).field("object").objectOf(schema);
}

export function partAlong(paths: { readonly [rowField: string]: ValuePath<unknown> }): PartDefinition {
  const routes = Object.entries(paths).map(([rowField, path]) => [rowField, routeOf(path)] as const);
  const [first] = routes;
  if (first === undefined) throw new Error("a part with no path reads nothing");
  const { start } = first[1];
  const other = routes.find(([, route]) => route.start?.link !== start?.link);
  if (other !== undefined)
    throw new Error(`the paths of a part start at one schema, and that of ${other[0]} at another`);
  return {
    ...(start === undefined ? {} : { schema: start }),
    paths: Object.fromEntries(routes.map(([rowField, { steps }]) => [rowField, steps])),
  };
}

function documentOf(schema: Schema): SchemaDocument {
  const bytes: Uint8Array = schema.bytes;
  return schemaLanguage.document(decodeObject(bytes, rootSchema).data);
}

class ObjectWalk {
  /** Left out where the walk does not say what schema the object is written to. */
  readonly document: SchemaDocument | undefined;
  readonly fields = new Map<string, ValueWalk>();
  link: ValueWalk | undefined;
  schema: ValueWalk | undefined;
  eachLink: ValueWalk | undefined;

  constructor(schema: Schema | undefined) {
    this.document = schema && documentOf(schema);
  }
}

interface FollowedLink {
  readonly schema: Schema;
  readonly walk: ObjectWalk;
}

class ValueWalk {
  readonly type: Item;
  readonly rowFields: string[] = [];
  readonly objects = new Map<Link<Schema>, FollowedLink>();
  eachInClosure: ValueWalk | undefined;

  constructor(type: Item) {
    this.type = type;
  }
}

const nameOf = (type: Item): string => (type.type === "array" ? `array of ${nameOf(type.items)}` : type.type);

const fieldOf = ({ fields }: SchemaDocument, name: string): Field | undefined =>
  Object.hasOwn(fields, name) ? fields[name] : undefined;

const typeOf = ({ optional: _, ...type }: Field): Item => type;

/**
 * - Paths that begin with the same steps share them in the walk, so each is taken once for an
 *   object read. A step that does not fit where it is taken from is refused here, before any blob
 *   is read.
 * - A part expands at one place, so that its rows are not every pairing of what two places give.
 */
function walkOf(rows: Schema, { schema, paths }: PartDefinition): ObjectWalk {
  const rowDocument = documentOf(rows);
  for (const name of Object.keys(rowDocument.fields))
    if (!Object.hasOwn(paths, name)) throw new Error(`no path is given for the field ${name} of ${rowDocument.title}`);
  const start = new ObjectWalk(schema);
  let expansion: ValueWalk | undefined;
  for (const [name, steps] of Object.entries(paths)) {
    const rowField = fieldOf(rowDocument, name);
    if (rowField === undefined) throw new Error(`a path is given for ${name}, which ${rowDocument.title} has not`);
    const refuse = (reason: string): never => {
      throw new Error(`the path of ${name} in ${rowDocument.title} ${reason}`);
    };
    const expansionAt = (taken: ValueWalk | undefined): ValueWalk => {
      if (taken !== undefined) return taken;
      if (expansion !== undefined) return refuse("expands at a second place, and a part expands at one");
      expansion = new ValueWalk({ type: "link" });
      return expansion;
    };
    let place: ObjectWalk | ValueWalk = start;
    for (const step of steps) {
      if (place instanceof ValueWalk) {
        if (step.step !== "object" && step.step !== "eachInClosure")
          return refuse(`takes the ${step.step} of a value, which has none`);
        if (place.type.type !== "link")
          return refuse(
            step.step === "object"
              ? `follows ${nameOf(place.type)}, and only a link leads to an object`
              : `expands the closure of ${nameOf(place.type)}, which is taken of a link`,
          );
        if (step.step === "eachInClosure") {
          place.eachInClosure = expansionAt(place.eachInClosure);
          place = place.eachInClosure;
        } else {
          const next: FollowedLink = place.objects.get(step.schema.link) ?? {
            schema: step.schema,
            walk: new ObjectWalk(step.schema),
          };
          place.objects.set(step.schema.link, next);
          place = next.walk;
        }
      } else if (step.step === "field") {
        if (place.document === undefined)
          return refuse(`takes the field ${step.name} of an object whose schema it does not say`);
        const { title } = place.document;
        const field = fieldOf(place.document, step.name);
        if (field === undefined) return refuse(`takes the field ${step.name}, which ${title} has not`);
        if (field.optional === true)
          return refuse(`takes the field ${step.name}, which an object of ${title} may leave out`);
        const next: ValueWalk = place.fields.get(step.name) ?? new ValueWalk(typeOf(field));
        place.fields.set(step.name, next);
        place = next;
      } else if (step.step === "link") {
        place.link ??= new ValueWalk({ type: "link" });
        place = place.link;
      } else if (step.step === "schema") {
        place.schema ??= new ValueWalk({ type: "link" });
        place = place.schema;
      } else if (step.step === "eachLink") {
        place.eachLink = expansionAt(place.eachLink);
        place = place.eachLink;
      } else if (step.step === "object") {
        return refuse("follows an object, and only a link leads to one");
      } else {
        return refuse("expands the closure of an object, which is taken of its link");
      }
    }
    if (place instanceof ObjectWalk) return refuse("ends at an object, and a row takes a value");
    const rowType = nameOf(typeOf(rowField));
    if (nameOf(place.type) !== rowType) return refuse(`gives ${nameOf(place.type)}, and the row takes ${rowType}`);
    place.rowFields.push(name);
  }
  return start;
}

interface BlobReader {
  /** What it throws fails whatever reads through it, even where that is caught on the way. */
  get(link: Link<unknown>): Promise<Uint8Array>;
}

/** `data` is held where the object was read to the schema that the walk says for it. */
interface ReadObject {
  readonly link: Link<unknown>;
  readonly bytes: Uint8Array;
  readonly data?: ValueMap;
}

type PartialRow = ReadonlyMap<string, Value>;

const rowsJoining = (rowsOfEach: readonly (readonly PartialRow[])[]): readonly PartialRow[] =>
  rowsOfEach.reduce<readonly PartialRow[]>(
    (joined, rows) => joined.flatMap((row) => rows.map((more) => new Map([...row, ...more]))),
    [new Map()],
  );

// Every path is taken before any of them is found to reach nothing: one that comes to a blob of
// another schema does not stop the others, as one of them may come to a blob that does not fit its
// schema, which fails the object read.
async function rowsFromObject(
  walk: ObjectWalk,
  object: ReadObject,
  reader: BlobReader,
): Promise<readonly PartialRow[]> {
  const rowsOfEach: (readonly PartialRow[])[] = [];
  for (const [name, next] of walk.fields) {
    const value = memberOf(object.data ?? {}, name);
    rowsOfEach.push(value === undefined ? [] : await rowsFromValue(next, value, reader));
  }
  if (walk.link !== undefined) rowsOfEach.push(await rowsFromValue(walk.link, new LinkValue(object.link), reader));
  if (walk.schema !== undefined)
    rowsOfEach.push(await rowsFromValue(walk.schema, new LinkValue(schemaOf(object.bytes)), reader));
  if (walk.eachLink !== undefined) rowsOfEach.push(await rowsFromEach(walk.eachLink, linksIn(object.bytes), reader));
  return rowsJoining(rowsOfEach);
}

async function rowsFromValue(walk: ValueWalk, value: Value, reader: BlobReader): Promise<readonly PartialRow[]> {
  const rowsOfEach: (readonly PartialRow[])[] = [[new Map(walk.rowFields.map((field) => [field, value]))]];
  if (walk.objects.size > 0 || walk.eachInClosure !== undefined) {
    if (!(value instanceof LinkValue)) return [];
    if (walk.objects.size > 0) {
      const bytes = await reader.get(value.link);
      for (const { schema, walk: next } of walk.objects.values()) {
        const isOfSchema = namedSchemaOf(bytes) === schema.link;
        rowsOfEach.push(isOfSchema ? await rowsFromObject(next, decodeObject(bytes, schema), reader) : []);
      }
    }
    if (walk.eachInClosure !== undefined) {
      const closure = await closureIn(reader, value.link);
      rowsOfEach.push(await rowsFromEach(walk.eachInClosure, closure.keys(), reader));
    }
  }
  return rowsJoining(rowsOfEach);
}

async function rowsFromEach(
  walk: ValueWalk,
  links: Iterable<Link<unknown>>,
  reader: BlobReader,
): Promise<readonly PartialRow[]> {
  const rows: PartialRow[] = [];
  for (const link of links) {
    try {
      rows.push(...(await rowsFromValue(walk, new LinkValue(link), reader)));
    } catch {
      // What an expansion goes over is not all of one making: a closure holds what anyone sent in
      // it. So a blob that does not fit its schema gives no row, and the others keep theirs. What
      // `reader` threw is not lost here: whoever gave the reader fails with that.
    }
  }
  return rows;
}

export function rowReaderOf(
  rows: Schema,
  definition: PartDefinition,
): (start: ReadObject, reader: BlobReader) => Promise<ValueMap[]> {
  const walk = walkOf(rows, definition);
  // A row may hold a field named `__proto__`, which assigning to an object would leave out.
  return async (start, reader) => (await rowsFromObject(walk, start, reader)).map((row) => Object.fromEntries(row));
}

/**
 * - It says how rows come of the blobs that a scan is over. Which blobs those are, what the rows are
 *   called and what they are ordered by are no part of it, so none of them changes its link.
 * - `rows` is the schema of the rows, and the rows are those that any part gives. A part reads the
 *   objects written to `schema`, the link of a schema, or every object where it holds none. Its
 *   `paths` hold under each field of a row the steps from an object read to the value of the field.
 * - A step is taken at an object or at a link. At an object, `{ step: "field", name }` takes a
 *   field of it, where a part or a step said its schema, `{ step: "link" }` its link,
 *   `{ step: "schema" }` the link of the schema it is written to, and `{ step: "eachLink" }` each
 *   link that it holds. At a link, `{ step: "object", schema }` takes the object that it leads to,
 *   where that is written to `schema`, and `{ step: "eachInClosure" }` the link of each blob in its
 *   closure, its own among them.
 * - The steps named `each` expand: the steps after one are taken from each value that it gives. The
 *   paths of a part expand at one place, which those that expand share the steps up to.
 * - Where no path expands, an object read gives a row where every path reaches a value. Where some do,
 *   it gives a row of each value of the expansion that every one of them reaches a value from, and
 *   each row holds what the other paths reach as well. It gives none where any other path reaches
 *   no value.
 * - A path reaches no value where a link that it follows leads to a blob that is not an object of
 *   the schema the step says.
 * - Where a path comes to a blob that names its schema and does not fit it, the value of an
 *   expansion that it came from gives no row. Where it came from none, the object read fails, even
 *   where another path leads to a blob of another schema. So where every blob that the paths come
 *   to can be read, whether an object read gives rows, none or a failure does not depend on the order
 *   the paths are taken in.
 */
const indexDefinitionSchema = schema("Index Definition", { rows: link<Schema>(), parts: array(any()) });

export type IndexDefinition = EncodedObject<DataOf<typeof indexDefinitionSchema>>;

const stepValueOf = (step: Step): ValueMap =>
  step.step === "object" ? { step: step.step, schema: new LinkValue(step.schema.link) } : step;

export function indexDefinitionOf(rows: Schema, parts: readonly PartDefinition[]): IndexDefinition {
  return encodeObject(indexDefinitionSchema, {
    rows: new LinkValue(rows.link),
    parts: parts.map(({ schema, paths }) => ({
      ...(schema === undefined ? {} : { schema: new LinkValue(schema.link) }),
      paths: Object.fromEntries(Object.entries(paths).map(([rowField, steps]) => [rowField, steps.map(stepValueOf)])),
    })),
  });
}
