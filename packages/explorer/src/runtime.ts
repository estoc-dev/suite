import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  isValueMap,
  itself,
  type Link,
  LinkValue,
  linkOf,
  namedSchemaOf,
  objectFormat,
  type Schema,
  schemaOf,
  type Value,
  type ValueMap,
} from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import { linksIn, type Store } from "@estoc/store";
import type { ListedAction } from "./action.ts";
import {
  actionSchema,
  actionsCall,
  blobCall,
  type CallKind,
  callSchema,
  listSchema,
  listsCall,
  pageCall,
  performCall,
  replySchema,
} from "./calls.ts";
import type { Channel } from "./channel.ts";
import { type List, pageIn } from "./list.ts";
import { heldLinks, heldObjects, type PairList } from "./pair-lists.ts";

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
 * - `rowOf` says what the blob of its link alone tells, so the rows of a page are made from the
 *   blobs of that page and no others.
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
    async page(store, prefix, start, limit) {
      const { links, blobCount } = await origin.read(store);
      // The list is sorted by no field, so no row is under a prefix that holds a value.
      const linksUnderPrefix = prefix.length === 0 ? links : [];
      const page = pageIn(linksUnderPrefix, start, limit);
      const rows: Uint8Array[] = [];
      for (const link of page.rows) {
        rows.push(encodeObject(rowSchema, rowOf(link, await heldBytesOf(store, link))).bytes);
      }
      return { start: page.start, rowCount: linksUnderPrefix.length, blobCount, rows };
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

/** The rows come of more than the blobs of one page, so each page reads every blob held. */
function listOfSortedPairs<First extends string, Second extends string>(
  { name, rowSchema, order }: PairList<First, Second>,
  pairsIn: (blob: Link<unknown>, bytes: Uint8Array) => Iterable<LinkPair>,
): List {
  const [first, second] = order;
  return {
    name,
    rowSchema,
    order,
    readsBlobs: heldBlobs.readsBlobs,
    async page(store, prefix, start, limit) {
      const { links, blobCount } = await heldBlobs.read(store);
      const isUnderPrefix = (pair: LinkPair) =>
        prefix.every((value, at) => value instanceof LinkValue && value.link === pair[at]);
      const pairs: LinkPair[] = [];
      for (const blob of links) {
        // One at a time: an object can hold more links than a call takes arguments.
        for (const pair of pairsIn(blob, await heldBytesOf(store, blob))) if (isUnderPrefix(pair)) pairs.push(pair);
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

const schemasList = listOfSortedPairs(heldObjects, function* (blob, bytes) {
  const schema = namedSchemaOf(bytes);
  if (schema !== undefined) yield [schema, blob];
});

const linksList = listOfSortedPairs(heldLinks, (blob, bytes) =>
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
 * What holds the store, and answers the calls of the pages that show it.
 *
 * - A page is given the whole of the store, Secrets as well: its user is inside the boundary that
 *   the store is in.
 * - A page has any of the actions performed on any request, so it signs and sends as any Signed
 *   Identity that the store holds, where the store records a Secret Key of the root or of an agent
 *   of its current version.
 */
export class Runtime {
  readonly #answers: ReadonlyMap<string, Answer>;

  /**
   * - `lists` are shown after those of what the store holds, and each has a name of its own.
   * - Each of `actions` has a request schema of its own.
   */
  constructor(store: Store, lists: readonly List[], actions: readonly ListedAction[]) {
    const listsByName = new Map<string, List>();
    for (const list of [recordsList, blobsList, schemasList, linksList, ...lists]) {
      if (listsByName.has(list.name)) throw new Error(`two lists are named ${list.name}`);
      listsByName.set(list.name, list);
    }
    const listDescriptions = Array.from(
      listsByName.values(),
      ({ name, rowSchema, order, readsBlobs }) =>
        encodeObject(listSchema, { name, rows: new LinkValue(rowSchema.link), order: [...order], readsBlobs }).bytes,
    );
    const actionsByRequestSchema = new Map<Link<unknown>, ListedAction>();
    for (const action of actions) {
      const { link } = action.requestSchema;
      if (actionsByRequestSchema.has(link)) throw new Error(`two actions take a request written to ${link}`);
      actionsByRequestSchema.set(link, action);
    }
    const actionDescriptions = actions.map(
      ({ requestSchema, resultSchema, targetSchemas }) =>
        encodeObject(actionSchema, {
          request: new LinkValue(requestSchema.link),
          result: new LinkValue(resultSchema.link),
          targetSchemas: Object.fromEntries(
            Object.entries(targetSchemas).flatMap(([field, schema]) =>
              schema === undefined ? [] : [[field, new LinkValue(schema.link)]],
            ),
          ),
        }).bytes,
    );
    // Rows, requests and results are not written to the store, and a page reads their schemas to
    // show them, as it reads the schema of what a field takes to say which objects fit.
    const shownSchemas = [
      ...Array.from(listsByName.values(), ({ rowSchema }) => rowSchema),
      ...actions.flatMap(({ requestSchema, resultSchema, targetSchemas }) => [
        requestSchema,
        resultSchema,
        ...Object.values(targetSchemas).filter((schema) => schema !== undefined),
      ]),
    ];
    const schemaBlobs = new Map<Link<unknown>, Uint8Array>(
      shownSchemas.flatMap(({ blobs }) => blobs.map((bytes) => [linkOf(bytes), bytes])),
    );
    this.#answers = new Map([
      answerTo(blobCall, async ({ link: { link } }) => {
        const bytes = (await store.get(link)) ?? schemaBlobs.get(link);
        return bytes === undefined ? {} : { bytes };
      }),
      answerTo(listsCall, async () => ({ lists: listDescriptions })),
      answerTo(pageCall, async ({ list: name, prefix, start, limit }) => {
        const list = listsByName.get(name);
        if (list === undefined) throw new Error(`there is no list named ${name}`);
        return list.page(store, prefix, start, limit);
      }),
      answerTo(actionsCall, async () => ({ actions: actionDescriptions })),
      answerTo(performCall, async ({ request }) => {
        const { schema, data } = objectFormat.decode(request);
        const requestSchema = schema === itself ? linkOf(request) : schema;
        const action = actionsByRequestSchema.get(requestSchema);
        if (action === undefined) throw new Error(`no action takes a request written to ${requestSchema}`);
        const { result, commits } = await action.perform(store, data);
        return { result: result.bytes, commits: commits.map((link) => new LinkValue(link)) };
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
