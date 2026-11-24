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

function pageIn<T>(rows: readonly T[], start: number, limit: number): { start: number; rows: T[] } {
  const first = start < 0 ? Math.max(rows.length + start, 0) : Math.min(start, rows.length);
  return { start: first, rows: rows.slice(first, first + Math.max(limit, 0)) };
}

interface LinksRead<T = unknown> {
  readonly links: readonly Link<T>[];
  readonly blobCount: number;
}

async function blobsHeldBy(store: Store): Promise<LinksRead> {
  const links: Link<unknown>[] = [];
  for await (const blob of store.blobs()) links.push(blob);
  return { links, blobCount: links.length };
}

async function heldBytesOf(store: Store, blob: Link<unknown>): Promise<Uint8Array> {
  const bytes = await store.get(blob);
  if (bytes === undefined) throw new Error(`the store lists ${blob} and does not hold it`);
  return bytes;
}

const descriptionOf = (name: string, rowSchema: Schema, order: string[], readsBlobs: boolean) =>
  encodeObject(listSchema, { name, rows: new LinkValue(rowSchema.link), order, readsBlobs });

/**
 * `read` gives links whose order only grows at the end, so a row keeps its place. `rowOf` says what
 * the blob of its link alone tells, so a page reads the blobs of that page and no others.
 */
function listInWrittenOrder<F extends ValueMap, T>(
  name: string,
  rowSchema: Schema<F>,
  readsBlobs: boolean,
  store: Store,
  read: () => Promise<LinksRead<T>>,
  rowOf: (link: Link<T>, bytes: Uint8Array) => F,
): List {
  return {
    description: descriptionOf(name, rowSchema, [], readsBlobs),
    rowSchema,
    async page(start, limit) {
      const { links, blobCount } = await read();
      const page = pageIn(links, start, limit);
      const rows: Uint8Array[] = [];
      for (const link of page.rows) {
        rows.push(encodeObject(rowSchema, rowOf(link, await heldBytesOf(store, link))).bytes);
      }
      return { start: page.start, rowCount: links.length, blobCount, rows };
    },
  };
}

export const recordedStatementSchema = schema("Recorded Statement", {
  statement: link<EncodedObject>(),
  schema: link<Schema>(),
});

function recordsList(store: Store): List {
  return listInWrittenOrder(
    "Records",
    recordedStatementSchema,
    false,
    store,
    async () => {
      const { statements, blobCount } = await store.recordedStatements();
      return { links: statements, blobCount };
    },
    (statement, bytes) => ({
      statement: new LinkValue(statement),
      schema: new LinkValue(schemaOf(bytes)),
    }),
  );
}

/** `size` is in bytes, and `schema` is left out for a blob that is not an object. */
export const heldBlobSchema = schema("Held Blob", { blob: link(), size: integer(), schema: optional(link<Schema>()) });

function blobsList(store: Store): List {
  return listInWrittenOrder(
    "Blobs",
    heldBlobSchema,
    true,
    store,
    () => blobsHeldBy(store),
    (blob, bytes) => {
      const schema = namedSchemaOf(bytes);
      return {
        blob: new LinkValue(blob),
        size: bytes.length,
        ...(schema === undefined ? {} : { schema: new LinkValue(schema) }),
      };
    },
  );
}

type LinkPair = readonly [first: Link<unknown>, second: Link<unknown>];

/** The rows come of more than the blobs of one page, so each page reads every blob held. */
function listOfSortedPairs<F extends ValueMap>(
  name: string,
  rowSchema: Schema<F>,
  order: [keyof F & string, keyof F & string],
  store: Store,
  pairsIn: (blob: Link<unknown>, bytes: Uint8Array) => Iterable<LinkPair>,
  rowOf: (pair: LinkPair) => F,
): List {
  return {
    description: descriptionOf(name, rowSchema, order, true),
    rowSchema,
    async page(start, limit) {
      const { links, blobCount } = await blobsHeldBy(store);
      const pairs: LinkPair[] = [];
      for (const blob of links) {
        // One at a time: an object can hold more links than a call takes arguments.
        for (const pair of pairsIn(blob, await heldBytesOf(store, blob))) pairs.push(pair);
      }
      const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      pairs.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
      const page = pageIn(pairs, start, limit);
      return {
        start: page.start,
        rowCount: pairs.length,
        blobCount,
        rows: page.rows.map((pair) => encodeObject(rowSchema, rowOf(pair)).bytes),
      };
    },
  };
}

export const heldObjectSchema = schema("Held Object", { schema: link<Schema>(), object: link<EncodedObject>() });

function schemasList(store: Store): List {
  return listOfSortedPairs(
    "Schemas",
    heldObjectSchema,
    ["schema", "object"],
    store,
    function* (blob, bytes) {
      const schema = namedSchemaOf(bytes);
      if (schema !== undefined) yield [schema, blob];
    },
    ([schema, object]) => ({
      schema: new LinkValue(schema as Link<Schema>),
      object: new LinkValue(object as Link<EncodedObject>),
    }),
  );
}

export const heldLinkSchema = schema("Held Link", { target: link(), source: link<EncodedObject>() });

/**
 * The rows under a blob are what links to it. A `source` that gives its schema by a link to
 * `target` is a row here as well as in Schemas.
 */
function linksList(store: Store): List {
  return listOfSortedPairs(
    "Links",
    heldLinkSchema,
    ["target", "source"],
    store,
    (blob, bytes) => Array.from(new Set(linksIn(bytes)), (target): LinkPair => [target, blob]),
    ([target, source]) => ({ target: new LinkValue(target), source: new LinkValue(source as Link<EncodedObject>) }),
  );
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
