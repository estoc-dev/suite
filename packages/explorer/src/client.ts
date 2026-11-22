import {
  decodeObject,
  type EncodedObject,
  encodeObject,
  isValueMap,
  type Link,
  LinkValue,
  linkOf,
  type Reader,
  type ValueMap,
} from "@estoc/object";
import type { DataOf } from "@estoc/schema";
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

type Reply = DataOf<typeof replySchema>;

/** What a page reads of the store by, over the channel to the runtime that holds it. */
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

  async #call<P extends ValueMap, R extends ValueMap>(kind: CallKind<P, R>, parameters: P): Promise<R> {
    if (this.#isClosed) throw new Error("the channel is closed");
    this.#lastId += 1;
    const id = this.#lastId;
    const waiting = new Promise<Reply>((resolve, reject) => this.#waitingCalls.set(id, { resolve, reject }));
    this.#channel.send(encodeObject(callSchema, { id, name: kind.name, parameters }).bytes);
    const { result, error } = await waiting;
    if (error !== undefined) throw new Error(error);
    if (result === undefined || !isValueMap(result)) throw new Error("the reply holds neither a result nor an error");
    return kind.result.validate(result);
  }
}
