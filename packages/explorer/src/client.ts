import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  isValueMap,
  type Link,
  LinkValue,
  linkOf,
  type Reader,
  type Schema,
  type ValueMap,
} from "@estoc/object";
import type { DataOf } from "@estoc/schema";
import {
  type ActionData,
  actionSchema,
  actionsCall,
  blobCall,
  type CallKind,
  callSchema,
  type LinkPageData,
  type ListData,
  listSchema,
  listsCall,
  objectsCall,
  type Page,
  pageCall,
  performCall,
  replySchema,
  sourcesCall,
} from "./calls.ts";
import type { Channel } from "./channel.ts";

type Reply = DataOf<typeof replySchema>;

/**
 * `start` is how many of the links come before `links`, `linkCount` how many there are, and
 * `blobCount` how many blobs the store held when the page was read.
 */
export interface LinkPage {
  readonly start: number;
  readonly linkCount: number;
  readonly blobCount: number;
  readonly links: readonly Link<unknown>[];
}

const linkPageOf = ({ links, ...counts }: LinkPageData): LinkPage => ({
  ...counts,
  links: links.map(({ link }) => link),
});

export class Client implements Reader {
  readonly #channel: Channel;
  readonly #waitingCalls = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  #lastId = 0;
  #isClosed = false;

  constructor(channel: Channel) {
    this.#channel = channel;
    channel.receive(
      (message) => {
        const reply = decodeObject(message, replySchema).data;
        this.#waitingCalls.get(reply.id)?.resolve(reply);
        this.#waitingCalls.delete(reply.id);
      },
      () => {
        this.#isClosed = true;
        for (const { reject } of this.#waitingCalls.values()) reject(new Error("the channel closed before the reply"));
        this.#waitingCalls.clear();
      },
    );
  }

  async get(link: Link<unknown>): Promise<Uint8Array | undefined> {
    const { bytes } = await this.#call(blobCall, { link: new LinkValue(link) });
    if (bytes !== undefined && linkOf(bytes) !== link) throw new Error(`the blob given for ${link} is another blob`);
    return bytes;
  }

  async lists(): Promise<EncodedObject<ListData>[]> {
    const { lists } = await this.#call(listsCall, {});
    return lists.map((bytes) => decodeObject(bytes, listSchema));
  }

  page(list: string, start: number, limit: number): Promise<Page> {
    return this.#call(pageCall, { list, start, limit });
  }

  async objectsOf(schema: Link<Schema>, start: number, limit: number): Promise<LinkPage> {
    return linkPageOf(await this.#call(objectsCall, { schema: new LinkValue(schema), start, limit }));
  }

  async sourcesOf(target: Link<unknown>, start: number, limit: number): Promise<LinkPage> {
    return linkPageOf(await this.#call(sourcesCall, { target: new LinkValue(target), start, limit }));
  }

  async actions(): Promise<EncodedObject<ActionData>[]> {
    const { actions } = await this.#call(actionsCall, {});
    return actions.map((bytes) => decodeObject(bytes, actionSchema));
  }

  /** `request` is the bytes of an object written to the request schema of an action. */
  async perform(request: Uint8Array): Promise<{ result: Uint8Array; commits: Link<unknown>[] }> {
    const { result, commits } = await this.#call(performCall, { request });
    return { result, commits: commits.map(({ link }) => link) };
  }

  async #call<P extends ValueMap, R extends ValueMap>(kind: CallKind<P, R>, parameters: P): Promise<R> {
    if (this.#isClosed) throw new Error("the channel is closed");
    this.#lastId += 1;
    const id = this.#lastId;
    const call = encodeObject(callSchema, { id, name: kind.name, parameters }).bytes;
    const { result, error } = await new Promise<Reply>((resolve, reject) => {
      this.#waitingCalls.set(id, { resolve, reject });
      this.#channel.send(call);
    });
    if (error !== undefined) throw new Error(error);
    if (result === undefined || !isValueMap(result)) throw new Error("the reply holds neither a result nor an error");
    return kind.result.validate(result);
  }
}
