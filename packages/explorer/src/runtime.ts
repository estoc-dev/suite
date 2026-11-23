import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  isValueMap,
  type Link,
  LinkValue,
  linkOf,
  namedSchemaOf,
  type Schema,
  schemaOf,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import { linksIn, type Store } from "@estoc/store";
import {
  blobCall,
  type CallKind,
  callSchema,
  type ListData,
  listSchema,
  listsCall,
  type Page,
  pageCall,
  replySchema,
} from "./calls.ts";
import type { Channel } from "./channel.ts";

interface List {
  readonly description: EncodedObject<ListData>;
  readonly rowSchema: Schema;
  page(start: number, limit: number): Promise<Page>;
}

/** The rows of a page of that `start` and `limit`, and where it begins counted from the front. */
function pageIn<T>(rows: readonly T[], start: number, limit: number): { start: number; rows: T[] } {
  const first = start < 0 ? Math.max(rows.length + start, 0) : Math.min(start, rows.length);
  return { start: first, rows: rows.slice(first, first + Math.max(limit, 0)) };
}

async function linksHeldBy(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const blob of store.blobs()) links.push(blob);
  return links;
}

async function heldBytesOf(store: Store, blob: Link<unknown>): Promise<Uint8Array> {
  const bytes = await store.get(blob);
  if (bytes === undefined) throw new Error(`the store lists ${blob} and does not hold it`);
  return bytes;
}

const descriptionOf = (name: string, rowSchema: Schema, order: string[], readsBlobs: boolean) =>
  encodeObject(listSchema, { name, rows: new LinkValue(rowSchema.link), order, readsBlobs });

/** `size` is in bytes, and `schema` is left out for a blob that is not an object. */
export const heldBlobSchema = schema("Held Blob", { blob: link(), size: integer(), schema: optional(link<Schema>()) });

/**
 * The blobs the store holds, in the order they were first written, so a row keeps its place and a
 * new one comes at the end. A row says what its blob alone tells, so a page reads the blobs of that
 * page and no others.
 */
function blobsList(store: Store): List {
  return {
    description: descriptionOf("Blobs", heldBlobSchema, [], true),
    rowSchema: heldBlobSchema,
    async page(start, limit) {
      const links = await linksHeldBy(store);
      const page = pageIn(links, start, limit);
      const rows: Uint8Array[] = [];
      for (const blob of page.rows) {
        const bytes = await heldBytesOf(store, blob);
        const schema = namedSchemaOf(bytes);
        const row: DataOf<typeof heldBlobSchema> = {
          blob: new LinkValue(blob),
          size: bytes.length,
          ...(schema === undefined ? {} : { schema: new LinkValue(schema) }),
        };
        rows.push(encodeObject(heldBlobSchema, row).bytes);
      }
      return { start: page.start, rowCount: links.length, blobCount: links.length, rows };
    },
  };
}

interface ReadRows<F extends ValueMap> {
  readonly rows: readonly F[];
  readonly blobCount: number;
}

/** A list whose rows come of more than the blobs of one page, so each page reads all of them. */
function listOf<F extends ValueMap>(
  name: string,
  rowSchema: Schema<F>,
  order: (keyof F & string)[],
  readsBlobs: boolean,
  read: () => Promise<ReadRows<F>>,
): List {
  return {
    description: descriptionOf(name, rowSchema, order, readsBlobs),
    rowSchema,
    async page(start, limit) {
      const { rows, blobCount } = await read();
      const page = pageIn(rows, start, limit);
      return {
        start: page.start,
        rowCount: rows.length,
        blobCount,
        rows: page.rows.map((row) => encodeObject(rowSchema, row).bytes),
      };
    },
  };
}

export const recordedStatementSchema = schema("Recorded Statement", {
  statement: link<EncodedObject>(),
  schema: link<Schema>(),
});

/** The statements recorded, in the order their Records were first written. */
function recordsList(store: Store): List {
  return listOf("Records", recordedStatementSchema, [], false, async () => {
    // Counted before the statements are read: a page that says fewer blobs than its rows were read
    // from is read again once more are written, and one that says more is not.
    const blobCount = (await linksHeldBy(store)).length;
    const rows: DataOf<typeof recordedStatementSchema>[] = [];
    for await (const statement of store.records()) {
      const schema = schemaOf(await heldBytesOf(store, statement));
      rows.push({ statement: new LinkValue(statement), schema: new LinkValue(schema) });
    }
    return { rows, blobCount };
  });
}

type LinkPair = readonly [first: Link<unknown>, second: Link<unknown>];

/** Every pair that `pairsIn` gives for a blob the store holds, sorted by the first link and then the second. */
async function sortedPairsOf(
  store: Store,
  pairsIn: (blob: Link<unknown>, bytes: Uint8Array) => Iterable<LinkPair>,
): Promise<{ pairs: LinkPair[]; blobCount: number }> {
  const links = await linksHeldBy(store);
  const pairs: LinkPair[] = [];
  for (const blob of links) pairs.push(...pairsIn(blob, await heldBytesOf(store, blob)));
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort((a, b) => order(a[0], b[0]) || order(a[1], b[1]));
  return { pairs, blobCount: links.length };
}

export const heldObjectSchema = schema("Held Object", { schema: link<Schema>(), object: link<EncodedObject>() });

/** Each object the store holds, under the schema it names. */
function schemasList(store: Store): List {
  return listOf("Schemas", heldObjectSchema, ["schema", "object"], true, async () => {
    const { pairs, blobCount } = await sortedPairsOf(store, function* (blob, bytes) {
      const schema = namedSchemaOf(bytes);
      if (schema !== undefined) yield [schema, blob];
    });
    const rows = pairs.map(([schema, object]) => ({
      schema: new LinkValue(schema as Link<Schema>),
      object: new LinkValue(object as Link<EncodedObject>),
    }));
    return { rows, blobCount };
  });
}

export const heldLinkSchema = schema("Held Link", { target: link(), source: link<EncodedObject>() });

/**
 * Each link of an object the store holds, under the blob it links to, so the rows under a blob are
 * what links to it. A `source` that names `target` as its schema is a row here as well as in Schemas.
 */
function linksList(store: Store): List {
  return listOf("Links", heldLinkSchema, ["target", "source"], true, async () => {
    const { pairs, blobCount } = await sortedPairsOf(store, (blob, bytes) =>
      Array.from(new Set(linksIn(bytes)), (target): LinkPair => [target, blob]),
    );
    const rows = pairs.map(([target, source]) => ({
      target: new LinkValue(target),
      source: new LinkValue(source as Link<EncodedObject>),
    }));
    return { rows, blobCount };
  });
}

type Answer = (parameters: Value) => Promise<ValueMap>;

function answerTo<P extends ValueMap, R extends ValueMap>(
  kind: CallKind<P, R>,
  answer: (parameters: P) => Promise<R>,
): [string, Answer] {
  return [
    kind.name,
    (parameters) => {
      if (!isValueMap(parameters)) throw new Error("the parameters of a call are a map");
      return answer(kind.parameters.validate(parameters));
    },
  ];
}

/**
 * What holds the store, and answers the calls of the pages that show it. A page is given the whole
 * of the store, Secrets as well: its user is inside the boundary that the store is in.
 */
export class Runtime {
  readonly #answers: ReadonlyMap<string, Answer>;

  constructor(store: Store) {
    const lists = new Map(
      [recordsList(store), blobsList(store), schemasList(store), linksList(store)].map((list) => [
        list.description.data.name,
        list,
      ]),
    );
    // A row and its schema are not written to the store, and a page reads the schema to show the row.
    const listedBlobs = new Map<Link<unknown>, Uint8Array>(
      [...lists.values()].flatMap(({ rowSchema }) => rowSchema.blobs.map((bytes) => [linkOf(bytes), bytes])),
    );
    this.#answers = new Map([
      answerTo(blobCall, async ({ link: { link } }) => {
        const bytes = (await store.get(link)) ?? listedBlobs.get(link);
        return bytes === undefined ? {} : { bytes };
      }),
      answerTo(listsCall, async () => ({ lists: Array.from(lists.values(), ({ description }) => description.bytes) })),
      answerTo(pageCall, async ({ list: name, start, limit }) => {
        const list = lists.get(name);
        if (list === undefined) throw new Error(`there is no list named ${name}`);
        return list.page(start, limit);
      }),
    ]);
  }

  /** Answers the calls that come over `channel`, each as it is done, so a long one holds up none after it. */
  serve(channel: Channel): void {
    channel.receive(
      async (message) => {
        let call: DataOf<typeof callSchema>;
        try {
          call = decodeObject(message, callSchema).data;
        } catch {
          // What is not a call has no id to answer under.
          channel.close();
          return;
        }
        channel.send(encodeObject(replySchema, { id: call.id, ...(await this.#outcomeOf(call)) }).bytes);
      },
      () => {},
    );
  }

  async #outcomeOf({ name, parameters }: DataOf<typeof callSchema>): Promise<{ result: ValueMap } | { error: string }> {
    try {
      const answer = this.#answers.get(name);
      if (answer === undefined) throw new Error(`there is no call named ${name}`);
      return { result: await answer(parameters) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
