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
import { recordSchema } from "./record.ts";
import type { ScannedBlob } from "./scanned-blob.ts";

type Step =
  | { readonly step: "as"; readonly schema: Schema }
  | { readonly step: "field"; readonly name: string }
  | { readonly step: "link" }
  | { readonly step: "schema" }
  | { readonly step: "eachLink" }
  | { readonly step: "object" }
  | { readonly step: "eachInClosure" };

/** A part reads the objects held. Each path starts at the object read, of whatever schema it is. */
export interface PartDefinition {
  readonly paths: { readonly [rowField: string]: readonly Step[] };
}

type Route = readonly Step[];

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
    return new ValuePath([...this.#route, { step: "field", name }]);
  }

  get link(): ValuePath<LinkValue<EncodedObject<F>>> {
    return new ValuePath([...this.#route, { step: "link" }]);
  }

  get schema(): ValuePath<LinkValue<Schema>> {
    return new ValuePath([...this.#route, { step: "schema" }]);
  }

  /**
   * A row of each link written in the object. That of its schema is among them unless the object is
   * written to itself.
   */
  eachLink(): ValuePath<LinkValue<unknown>> {
    return new ValuePath([...this.#route, { step: "eachLink" }]);
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
    return new ObjectPath([...this.#route, { step: "object" }, { step: "as", schema }]);
  }

  /** A row of the link of each blob in the closure of the link, its own among them. */
  eachInClosure(this: ValuePath<LinkValue<unknown>>): ValuePath<LinkValue<unknown>> {
    return new ValuePath([...this.#route, { step: "eachInClosure" }]);
  }
}

/**
 * An object held of any schema, what a stranger sent as well as the store's own. A scan reads
 * every blob it is over once for each index that reads this way.
 */
export const anyHeldObject: ObjectPath<Record<never, never>> = new ObjectPath([]);

/**
 * - Anyone can send a bundle with an object of any schema in it, so an object read this way may be
 *   a stranger's, unless `schema` is that of a Record, which the store alone writes.
 * - A scan reads every blob it is over once for each index that reads this way. The Records are
 *   read once for all of them.
 */
export function heldObject<F extends ValueMap>(schema: Schema<F>): ObjectPath<F> {
  return new ObjectPath([{ step: "as", schema }]);
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
  if (routes.length === 0) throw new Error("a part with no path reads nothing");
  return { paths: Object.fromEntries(routes) };
}

/**
 * The schema that every path of the part takes the object read as, where there is one: the part
 * gives no row of an object of another, so whoever reads for it can pass those by.
 */
export function startSchemaOf({ paths }: PartDefinition): Schema | undefined {
  const [first, ...others] = Object.values(paths).map(([firstStep]) => firstStep);
  if (first?.step !== "as") return undefined;
  const isSharedByAll = others.every((step) => step?.step === "as" && step.schema.link === first.schema.link);
  return isSharedByAll ? first.schema : undefined;
}

interface TakenSchema {
  readonly schema: Schema;
  readonly walk: ObjectWalk;
}

class ObjectWalk {
  /** Left out where no step has said what schema the object is written to. */
  readonly document: SchemaDocument | undefined;
  readonly fields = new Map<string, ValueWalk>();
  link: ValueWalk | undefined;
  schema: ValueWalk | undefined;
  eachLink: ValueWalk | undefined;
  takenAs: TakenSchema | undefined;

  constructor(schema?: Schema) {
    this.document = schema?.document;
  }
}

class ValueWalk {
  readonly type: Item;
  readonly rowFields: string[] = [];
  object: ObjectWalk | undefined;
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
 * - Paths that take one object as two schemas are refused as well: an object is written to one, so
 *   they would give no row of any object.
 * - A part expands at one place, so that its rows are not every pairing of what two places give.
 */
function walkOf(rows: Schema, { paths }: PartDefinition): ObjectWalk {
  const rowDocument = rows.document;
  for (const name of Object.keys(rowDocument.fields))
    if (!Object.hasOwn(paths, name)) throw new Error(`no path is given for the field ${name} of ${rowDocument.title}`);
  const start = new ObjectWalk();
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
          place.object ??= new ObjectWalk();
          place = place.object;
        }
      } else if (step.step === "as") {
        const { title } = step.schema.document;
        if (place.document !== undefined)
          return refuse(`takes as ${title} an object that it took as ${place.document.title}`);
        place.takenAs ??= { schema: step.schema, walk: new ObjectWalk(step.schema) };
        if (place.takenAs.schema.link !== step.schema.link)
          return refuse(`takes as ${title} an object that another path takes as ${place.takenAs.walk.document?.title}`);
        place = place.takenAs.walk;
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

type PartialRow = ReadonlyMap<string, Value>;

const rowsJoining = (rowsOfEach: readonly (readonly PartialRow[])[]): readonly PartialRow[] =>
  rowsOfEach.reduce<readonly PartialRow[]>(
    (joined, rows) => joined.flatMap((row) => rows.map((more) => new Map([...row, ...more]))),
    [new Map()],
  );

// Every path is taken before any of them is found to reach nothing: one that comes to an object of
// another schema does not stop the others, as one of them may come to a blob that does not fit its
// schema, which fails the object read.
async function rowsFromObject(
  walk: ObjectWalk,
  blob: ScannedBlob,
  data: ValueMap | undefined,
  start: ScannedBlob,
): Promise<readonly PartialRow[]> {
  const schema = await blob.namedSchema();
  if (schema === undefined) return [];
  const rowsOfEach: (readonly PartialRow[])[] = [];
  for (const [name, next] of walk.fields) {
    const value = memberOf(data ?? {}, name);
    rowsOfEach.push(value === undefined ? [] : await rowsFromValue(next, value, start));
  }
  if (walk.link !== undefined) rowsOfEach.push(await rowsFromValue(walk.link, new LinkValue(blob.link), start));
  if (walk.schema !== undefined) rowsOfEach.push(await rowsFromValue(walk.schema, new LinkValue(schema), start));
  if (walk.eachLink !== undefined) rowsOfEach.push(await rowsFromEach(walk.eachLink, await blob.links(), start));
  if (walk.takenAs !== undefined) {
    const object = await blob.objectOf(walk.takenAs.schema);
    rowsOfEach.push(object === undefined ? [] : await rowsFromObject(walk.takenAs.walk, blob, object.data, start));
  }
  return rowsJoining(rowsOfEach);
}

async function rowsFromValue(walk: ValueWalk, value: Value, start: ScannedBlob): Promise<readonly PartialRow[]> {
  const rowsOfEach: (readonly PartialRow[])[] = [[new Map(walk.rowFields.map((field) => [field, value]))]];
  if (walk.object !== undefined || walk.eachInClosure !== undefined) {
    if (!(value instanceof LinkValue)) return [];
    if (walk.object !== undefined)
      rowsOfEach.push(await rowsFromObject(walk.object, start.blobAt(value.link), undefined, start));
    if (walk.eachInClosure !== undefined)
      rowsOfEach.push(await rowsFromEach(walk.eachInClosure, await closureLinksAt(value.link, start), start));
  }
  return rowsJoining(rowsOfEach);
}

async function closureLinksAt(link: Link<unknown>, start: ScannedBlob): Promise<Link<unknown>[]> {
  const closureLinks: Link<unknown>[] = [];
  const seenLinks = new Set([link]);
  const pendingLinks = [link];
  for (let next = pendingLinks.pop(); next !== undefined; next = pendingLinks.pop()) {
    closureLinks.push(next);
    for (const targetLink of await start.blobAt(next).links()) {
      if (seenLinks.has(targetLink)) continue;
      seenLinks.add(targetLink);
      pendingLinks.push(targetLink);
    }
  }
  return closureLinks;
}

async function rowsFromEach(
  walk: ValueWalk,
  links: Iterable<Link<unknown>>,
  start: ScannedBlob,
): Promise<readonly PartialRow[]> {
  const rows: PartialRow[] = [];
  for (const link of links) {
    try {
      rows.push(...(await rowsFromValue(walk, new LinkValue(link), start)));
    } catch {
      // What an expansion goes over is not all of one making: a closure holds what anyone sent in
      // it. So a blob that does not fit its schema gives no row, and the others keep theirs. A blob
      // that the store failed to give is not lost here: the reader of `start` keeps the failure.
    }
  }
  return rows;
}

export function rowReaderOf(rows: Schema, definition: PartDefinition): (start: ScannedBlob) => Promise<ValueMap[]> {
  const walk = walkOf(rows, definition);
  // A row may hold a field named `__proto__`, which assigning to an object would leave out.
  return async (start) => (await rowsFromObject(walk, start, undefined, start)).map((row) => Object.fromEntries(row));
}

/**
 * - It says how rows come of the blobs that a scan is over. Which blobs those are, what the rows are
 *   called and what they are ordered by are no part of it, so none of them changes its link.
 * - `rows` is the schema of the rows, and the rows are those that any part gives. A part reads
 *   every object among the blobs, and its `paths` hold under each field of a row the steps from an
 *   object read to the value of the field.
 * - A step is taken at an object or at a link. At an object, `{ step: "as", schema }` takes it as
 *   an object of `schema`, the link of a schema, `{ step: "field", name }` a field of it, once a
 *   step took it as a schema, `{ step: "link" }` its link, `{ step: "schema" }` the link of the
 *   schema it is written to, and `{ step: "eachLink" }` each link that it holds. At a link,
 *   `{ step: "object" }` takes the object that it leads to, and `{ step: "eachInClosure" }` the
 *   link of each blob in its closure, its own among them.
 * - The steps named `each` expand: the steps after one are taken from each value that it gives. The
 *   paths of a part expand at one place, which those that expand share the steps up to.
 * - Where no path expands, an object read gives a row where every path reaches a value. Where some
 *   do, it gives a row of each value of the expansion that every one of them reaches a value from,
 *   and each row holds what the other paths reach as well. It gives none where any other path
 *   reaches no value.
 * - A path reaches no value where it takes an object as a schema that it is not written to, and
 *   where it follows a link to a blob that is not an object.
 * - Where a path takes as a schema an object that names the schema and does not fit it, the value
 *   of an expansion that it came from gives no row. Where it came from none, the object read fails,
 *   even where another path takes an object as a schema that it is not written to. So where every
 *   blob that the paths come to can be read, whether an object read gives rows, none or a failure
 *   does not depend on the order the paths are taken in.
 */
const indexDefinitionSchema = schema("Index Definition", { rows: link<Schema>(), parts: array(any()) });

export type IndexDefinition = EncodedObject<DataOf<typeof indexDefinitionSchema>>;

const stepValueOf = (step: Step): ValueMap =>
  step.step === "as" ? { step: step.step, schema: new LinkValue(step.schema.link) } : step;

export function indexDefinitionOf(rows: Schema, parts: readonly PartDefinition[]): IndexDefinition {
  return encodeObject(indexDefinitionSchema, {
    rows: new LinkValue(rows.link),
    parts: parts.map(({ paths }) => ({
      paths: Object.fromEntries(Object.entries(paths).map(([rowField, steps]) => [rowField, steps.map(stepValueOf)])),
    })),
  });
}
