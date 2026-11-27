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
import { anyMemberObject, heldBlobs, heldObjects, type Store } from "@estoc/store";
import type { ListedAction } from "./action.ts";
import {
  actionSchema,
  actionsCall,
  blobCall,
  type CallKind,
  callSchema,
  type LinkPageData,
  listSchema,
  listsCall,
  objectsCall,
  pageCall,
  performCall,
  replySchema,
  sourcesCall,
} from "./calls.ts";
import type { Channel } from "./channel.ts";
import { type List, listOfIndex, pageIn } from "./list.ts";

interface LinksRead<T = unknown> {
  readonly links: readonly Link<T>[];
  readonly blobCount: number;
}

interface Origin<T = unknown> {
  /** The order of the links only grows at the end. */
  read(store: Store): Promise<LinksRead<T>>;
}

const recordedStatements: Origin<EncodedObject> = {
  async read(store) {
    const { statements, blobCount } = await store.recordedStatements();
    return { links: statements, blobCount };
  },
};

const blobLinks: Origin = {
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

const blobsList = listInWrittenOrder("Blobs", heldBlobSchema, blobLinks, (blob, bytes) => {
  const schema = namedSchemaOf(bytes);
  return {
    blob: new LinkValue(blob),
    size: bytes.length,
    ...(schema === undefined ? {} : { schema: new LinkValue(schema) }),
  };
});

/** A `source` that gives its schema by a link to `target` is a row here as well as in Schemas. */
export const heldLinkSchema = schema("Held Link", { target: link(), source: link() });

const heldLinks = heldBlobs
  .rowsTaking(heldLinkSchema, { target: anyMemberObject.link, source: anyMemberObject.link })
  .rowsOfEachLinkFrom("target");

async function linkPageOf<F extends ValueMap>(
  rows: AsyncIterable<EncodedObject<F>>,
  linkIn: (row: F) => LinkValue<unknown>,
  blobCount: number,
  start: number,
  limit: number,
): Promise<LinkPageData> {
  const links: LinkValue<unknown>[] = [];
  for await (const { data } of rows) links.push(linkIn(data));
  const page = pageIn(links, start, limit);
  return { start: page.start, linkCount: links.length, blobCount, links: page.rows };
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
    for (const list of [
      recordsList,
      blobsList,
      listOfIndex(heldObjects, "Schemas", ["schema", "object"]),
      listOfIndex(heldLinks, "Links", ["target", "source"]),
      ...lists,
    ]) {
      if (listsByName.has(list.name)) throw new Error(`two lists are named ${list.name}`);
      listsByName.set(list.name, list);
    }
    const listDescriptions = Array.from(
      listsByName.values(),
      ({ name, rowSchema, order }) =>
        encodeObject(listSchema, { name, rows: new LinkValue(rowSchema.link), order: [...order] }).bytes,
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
      answerTo(pageCall, async ({ list: name, start, limit }) => {
        const list = listsByName.get(name);
        if (list === undefined) throw new Error(`there is no list named ${name}`);
        return list.page(store, start, limit);
      }),
      answerTo(objectsCall, async ({ schema, start, limit }) => {
        const rows = await store.scan(heldObjects);
        const objects = rows.orderedBy("schema", "object").range([schema]);
        return linkPageOf(objects, ({ object }) => object, rows.blobCount, start, limit);
      }),
      answerTo(sourcesCall, async ({ target, start, limit }) => {
        const rows = await store.scan(heldLinks);
        const sources = rows.orderedBy("target", "source").range([target]);
        return linkPageOf(sources, ({ source }) => source, rows.blobCount, start, limit);
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
