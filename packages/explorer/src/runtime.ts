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
  type Value,
  type ValueMap,
} from "@estoc/object";
import { type DataOf, integer, link, optional, schema } from "@estoc/schema";
import type { Store } from "@estoc/store";
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

/** `size` is in bytes, and `schema` is left out for a blob that is not an object. */
export const heldBlobSchema = schema("Held Blob", { blob: link(), size: integer(), schema: optional(link<Schema>()) });

/**
 * The blobs the store holds, in the order they were first written, so a row keeps its place and a
 * new one comes at the end. A row says what its blob alone tells, so a page reads the blobs of that
 * page and no others.
 */
function blobsList(store: Store): List {
  return {
    description: encodeObject(listSchema, {
      name: "Blobs",
      rows: new LinkValue(heldBlobSchema.link),
      order: [],
      readsBlobs: true,
    }),
    rowSchema: heldBlobSchema,
    async page(start, limit) {
      const links: Link<unknown>[] = [];
      for await (const blob of store.blobs()) links.push(blob);
      const first = start < 0 ? Math.max(links.length + start, 0) : Math.min(start, links.length);
      const rows: Uint8Array[] = [];
      for (const blob of links.slice(first, first + Math.max(limit, 0))) {
        const bytes = await store.get(blob);
        if (bytes === undefined) throw new Error(`the store lists ${blob} and does not hold it`);
        const schema = namedSchemaOf(bytes);
        const row: DataOf<typeof heldBlobSchema> = {
          blob: new LinkValue(blob),
          size: bytes.length,
          ...(schema === undefined ? {} : { schema: new LinkValue(schema) }),
        };
        rows.push(encodeObject(heldBlobSchema, row).bytes);
      }
      return { start: first, rowCount: links.length, blobCount: links.length, rows };
    },
  };
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
    const lists = new Map([blobsList(store)].map((list) => [list.description.data.name, list]));
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
