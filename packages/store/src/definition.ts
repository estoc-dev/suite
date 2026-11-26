import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  type Field,
  type Item,
  type Link,
  LinkValue,
  memberOf,
  namedSchemaOf,
  type Schema,
  type SchemaDocument,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { any, array, type DataOf, link, schema } from "@estoc/schema";
import { recordSchema } from "./record.ts";

type Step =
  | { readonly step: "field"; readonly name: string }
  | { readonly step: "link" }
  | { readonly step: "object"; readonly schema: Schema };

/**
 * A part reads the blobs held that are objects of `schema`, and gives a row of each one that every
 * path reaches a value from. Each path starts at the object read.
 */
export interface PartDefinition {
  readonly schema: Schema;
  readonly paths: { readonly [rowField: string]: readonly Step[] };
}

interface Route {
  readonly start: Schema;
  readonly steps: readonly Step[];
}

const routeWith = ({ start, steps }: Route, step: Step): Route => ({ start, steps: [...steps, step] });

declare const end: unique symbol;

let routeOf: (path: ValuePath<unknown>) => Route;

type FieldsHeldIn<F> = { [N in keyof F & string]-?: undefined extends F[N] ? never : N }[keyof F & string];

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

  /** Where the link leads to a blob that is not an object of `schema`, the item gives no row. */
  objectOf<F extends ValueMap>(this: ValuePath<LinkValue<unknown>>, schema: Schema<F>): ObjectPath<F> {
    return new ObjectPath(routeWith(this.#route, { step: "object", schema }));
  }
}

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
  const start = routes[0]?.[1].start;
  if (start === undefined) throw new Error("a part with no path reads nothing");
  const other = routes.find(([, route]) => route.start.link !== start.link);
  if (other !== undefined)
    throw new Error(`the paths of a part start at one schema, and that of ${other[0]} at another`);
  return { schema: start, paths: Object.fromEntries(routes.map(([rowField, { steps }]) => [rowField, steps])) };
}

class ObjectWalk {
  readonly document: SchemaDocument;
  readonly fields = new Map<string, ValueWalk>();
  link: ValueWalk | undefined;

  constructor(schema: Schema) {
    this.document = schema.document;
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

  constructor(type: Item) {
    this.type = type;
  }
}

const nameOf = (type: Item): string => (type.type === "array" ? `array of ${nameOf(type.items)}` : type.type);

const fieldOf = ({ fields }: SchemaDocument, name: string): Field | undefined =>
  Object.hasOwn(fields, name) ? fields[name] : undefined;

const typeOf = ({ optional: _, ...type }: Field): Item => type;

/**
 * Paths that begin with the same steps share them in the walk, so each is taken once for an object
 * read. A step that does not fit where it is taken from is refused here, before any blob is read.
 */
function walkOf(rows: Schema, { schema, paths }: PartDefinition): ObjectWalk {
  const rowDocument = rows.document;
  for (const name of Object.keys(rowDocument.fields))
    if (!Object.hasOwn(paths, name)) throw new Error(`no path is given for the field ${name} of ${rowDocument.title}`);
  const start = new ObjectWalk(schema);
  for (const [name, steps] of Object.entries(paths)) {
    const rowField = fieldOf(rowDocument, name);
    if (rowField === undefined) throw new Error(`a path is given for ${name}, which ${rowDocument.title} has not`);
    const refuse = (reason: string): never => {
      throw new Error(`the path of ${name} in ${rowDocument.title} ${reason}`);
    };
    let place: ObjectWalk | ValueWalk = start;
    for (const step of steps) {
      if (place instanceof ValueWalk) {
        if (step.step !== "object") return refuse(`takes the ${step.step} of a value, which has none`);
        if (place.type.type !== "link")
          return refuse(`follows ${nameOf(place.type)}, and only a link leads to an object`);
        const next: FollowedLink = place.objects.get(step.schema.link) ?? {
          schema: step.schema,
          walk: new ObjectWalk(step.schema),
        };
        place.objects.set(step.schema.link, next);
        place = next.walk;
      } else if (step.step === "field") {
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
      } else {
        return refuse("follows an object, and only a link leads to one");
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
  get(link: Link<unknown>): Promise<Uint8Array>;
}

type Row = Map<string, Value>;

// A path that comes to a blob of another schema does not stop the others, as one of them may come
// to a blob that does not fit its schema, which fails the object read.
async function fillFromObject(row: Row, walk: ObjectWalk, object: EncodedObject, reader: BlobReader): Promise<boolean> {
  let reachesAll = true;
  for (const [name, next] of walk.fields) {
    const value = memberOf(object.data, name);
    if (value === undefined || !(await fillFromValue(row, next, value, reader))) reachesAll = false;
  }
  if (walk.link !== undefined && !(await fillFromValue(row, walk.link, new LinkValue(object.link), reader)))
    reachesAll = false;
  return reachesAll;
}

async function fillFromValue(row: Row, walk: ValueWalk, value: Value, reader: BlobReader): Promise<boolean> {
  for (const field of walk.rowFields) row.set(field, value);
  if (walk.objects.size === 0) return true;
  if (!(value instanceof LinkValue)) return false;
  const bytes = await reader.get(value.link);
  let reachesAll = true;
  for (const { schema, walk: next } of walk.objects.values())
    if (namedSchemaOf(bytes) !== schema.link || !(await fillFromObject(row, next, decodeObject(bytes, schema), reader)))
      reachesAll = false;
  return reachesAll;
}

export function rowReaderOf(
  rows: Schema,
  definition: PartDefinition,
): (start: EncodedObject, reader: BlobReader) => Promise<ValueMap | undefined> {
  const walk = walkOf(rows, definition);
  return async (start, reader) => {
    const row: Row = new Map();
    // A row may hold a field named `__proto__`, which assigning to an object would leave out.
    return (await fillFromObject(row, walk, start, reader)) ? Object.fromEntries(row) : undefined;
  };
}

/**
 * - It says how rows come of the blobs that a scan is over. Which blobs those are, what the rows are
 *   called and what they are ordered by are no part of it, so none of them changes its link.
 * - `rows` is the schema of the rows, and the rows are those that any part gives. A part holds
 *   `schema`, the link of the schema of the blobs it reads, and `paths`, which holds under each
 *   field of a row the steps from a blob read to the value of the field.
 * - A step is one of three. `{ step: "field", name }` takes a field of the object it is at,
 *   `{ step: "link" }` the link of that object, and `{ step: "object", schema }` the object that
 *   the link it is at leads to, where that is written to `schema`.
 * - A blob read gives a row where every path reaches a value, and none where a link that a path
 *   follows leads to a blob of another schema. Where any path comes to a blob that names its schema
 *   and does not fit it, the blob read fails, even where another path leads to a blob of another
 *   schema. So where every blob that the paths come to can be read, whether a blob read gives a
 *   row, none or a failure does not depend on the order the paths are taken in.
 */
const indexDefinitionSchema = schema("Index Definition", { rows: link<Schema>(), parts: array(any()) });

export type IndexDefinition = EncodedObject<DataOf<typeof indexDefinitionSchema>>;

const stepValueOf = (step: Step): ValueMap =>
  step.step === "object" ? { step: step.step, schema: new LinkValue(step.schema.link) } : step;

export function indexDefinitionOf(rows: Schema, parts: readonly PartDefinition[]): IndexDefinition {
  return encodeObject(indexDefinitionSchema, {
    rows: new LinkValue(rows.link),
    parts: parts.map(({ schema, paths }) => ({
      schema: new LinkValue(schema.link),
      paths: Object.fromEntries(Object.entries(paths).map(([rowField, steps]) => [rowField, steps.map(stepValueOf)])),
    })),
  });
}
