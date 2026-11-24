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
import { blobCall, type CallKind, callSchema, listSchema, listsCall, pageCall, replySchema } from "./calls.ts";
import type { Channel } from "./channel.ts";
import { type List, pageIn } from "./list.ts";

interface LinksRead<T = unknown> {
  readonly links: readonly Link<T>[];
  readonly blobCount: number;
}

interface Origin<T = unknown> {
  readonly readsBlobs: boolean;
  /** The order of the links only grows at the end. */
  read(store: Store): Promise<LinksRead<T>>;
}

const recordedStatements: Origin<EncodedObject> = {
  readsBlobs: false,
  async read(store) {
    const { statements, blobCount } = await store.recordedStatements();
    return { links: statements, blobCount };
  },
};

const heldBlobs: Origin = {
  readsBlobs: true,
  async read(store) {
    const links: Link<unknown>[] = [];
    for await (const blob of store.blobs()) links.push(blob);
    return { links, blobCount: links.length };
  },
};

async function heldBytesOf(store: Store, blob: Link<unknown>): Promise<Uint8Array> {
  const bytes = await store.get(blob);
  if (bytes === undefined) throw new Error(`the store lists ${blob} and does not hold it`);
  return bytes;
}

/**
 * - The rows are in the order of the links of `origin`, so a row keeps its place.
 * - `rowOf` says what the blob of its link alone tells, so a page reads the blobs of that page and
 *   no others.
 */
function listInWrittenOrder<F extends ValueMap, T>(
  name: string,
  rowSchema: Schema<F>,
  origin: Origin<T>,
  rowOf: (link: Link<T>, bytes: Uint8Array) => F,
): List {
  return {
    name,
    rowSchema,
    order: [],
    readsBlobs: origin.readsBlobs,
    async page(store, start, limit) {
      const { links, blobCount } = await origin.read(store);
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

const recordsList = listInWrittenOrder("Records", recordedStatementSchema, recordedStatements, (statement, bytes) => ({
  statement: new LinkValue(statement),
  schema: new LinkValue(schemaOf(bytes)),
}));

/** `size` is in bytes, and `schema` is left out for a blob that is not an object. */
export const heldBlobSchema = schema("Held Blob", { blob: link(), size: integer(), schema: optional(link<Schema>()) });

const blobsList = listInWrittenOrder("Blobs", heldBlobSchema, heldBlobs, (blob, bytes) => {
  const schema = namedSchemaOf(bytes);
  return {
    blob: new LinkValue(blob),
    size: bytes.length,
    ...(schema === undefined ? {} : { schema: new LinkValue(schema) }),
  };
});

type LinkPair = readonly [first: Link<unknown>, second: Link<unknown>];

/**
 * - A row holds a pair under the two fields of `order`, the first of the pair under the first.
 * - The rows come of more than the blobs of one page, so each page reads every blob held.
 */
function listOfSortedPairs<F extends { readonly [field: string]: LinkValue<unknown> }>(
  name: string,
  rowSchema: Schema<F>,
  order: readonly [keyof F & string, keyof F & string],
  pairsIn: (blob: Link<unknown>, bytes: Uint8Array) => Iterable<LinkPair>,
): List {
  const [first, second] = order;
  return {
    name,
    rowSchema,
    order,
    readsBlobs: heldBlobs.readsBlobs,
    async page(store, start, limit) {
      const { links, blobCount } = await heldBlobs.read(store);
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
        rows: page.rows.map(
          (pair) =>
            encodeObject<ValueMap>(rowSchema, { [first]: new LinkValue(pair[0]), [second]: new LinkValue(pair[1]) })
              .bytes,
        ),
      };
    },
  };
}

export const heldObjectSchema = schema("Held Object", { schema: link<Schema>(), object: link<EncodedObject>() });

const schemasList = listOfSortedPairs("Schemas", heldObjectSchema, ["schema", "object"], function* (blob, bytes) {
  const schema = namedSchemaOf(bytes);
  if (schema !== undefined) yield [schema, blob];
});

export const heldLinkSchema = schema("Held Link", { target: link(), source: link<EncodedObject>() });

/**
 * The rows under a blob are what links to it. A `source` that gives its schema by a link to
 * `target` is a row here as well as in Schemas.
 */
const linksList = listOfSortedPairs("Links", heldLinkSchema, ["target", "source"], (blob, bytes) =>
  Array.from(new Set(linksIn(bytes)), (target): LinkPair => [target, blob]),
);

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

  /** `lists` are shown after those of what the store holds, and each has a name of its own. */
  constructor(store: Store, lists: readonly List[]) {
    const listsByName = new Map<string, List>();
    for (const list of [recordsList, blobsList, schemasList, linksList, ...lists]) {
      if (listsByName.has(list.name)) throw new Error(`two lists are named ${list.name}`);
      listsByName.set(list.name, list);
    }
    const descriptions = Array.from(
      listsByName.values(),
      ({ name, rowSchema, order, readsBlobs }) =>
        encodeObject(listSchema, { name, rows: new LinkValue(rowSchema.link), order: [...order], readsBlobs }).bytes,
    );
    // A row and its schema are not written to the store, and a page reads the schema to show the row.
    const listedBlobs = new Map<Link<unknown>, Uint8Array>(
      [...listsByName.values()].flatMap(({ rowSchema }) => rowSchema.blobs.map((bytes) => [linkOf(bytes), bytes])),
    );
    this.#answers = new Map([
      answerTo(blobCall, async ({ link: { link } }) => {
        const bytes = (await store.get(link)) ?? listedBlobs.get(link);
        return bytes === undefined ? {} : { bytes };
      }),
      answerTo(listsCall, async () => ({ lists: descriptions })),
      answerTo(pageCall, async ({ list: name, start, limit }) => {
        const list = listsByName.get(name);
        if (list === undefined) throw new Error(`there is no list named ${name}`);
        return list.page(store, start, limit);
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
