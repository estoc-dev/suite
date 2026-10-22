import type { Bundle } from "@estoc/bundle";
import type { MailboxKey, Transport } from "@estoc/mailbox";
import { decodeObject, type Bytes, type EncodedObject, type Json } from "@estoc/object";
import { hex } from "@scure/base";

/** A message taken from the queue: the bundle it held, or why it did not open. */
export type Taken = { readonly id: string; readonly bundle: Bundle } | { readonly id: string; readonly refused: unknown };

/**
 * The queue of a mailbox on a `TestMailboxServer`, bound to the key that
 * opens what is sent there.
 */
export class TestInbox {
  readonly #url: string;
  readonly #key: MailboxKey;

  private constructor(url: string, key: MailboxKey) {
    this.#url = url;
    this.#key = key;
  }

  /**
   * Reads `mailbox` as a mailbox of `http`, the transport of
   * `@estoc/mailbox/http`, and refuses it when its key is not `key`'s.
   */
  static from(mailbox: Bytes<EncodedObject<Json>>, key: MailboxKey, http: Transport): TestInbox {
    const { data } = decodeObject(mailbox, http.schema);
    const { key: named, url } = data as { readonly key: string; readonly url: string };
    if (named !== hex.encode(key.publicKey)) throw new Error("the mailbox names another key than this one");
    return new TestInbox(url, key);
  }

  /**
   * Takes each message waiting in the queue: opens it, hands the bundle to
   * `keep`, and deletes the message once `keep` resolves. When `keep`
   * rejects, so does `take`, and the message waits for the next. A message
   * that does not open, with the key or as a bundle, will not open later
   * either, so it is deleted as well and given back as refused.
   */
  async take(keep: (bundle: Bundle) => Promise<void>): Promise<Taken[]> {
    const ids: unknown = await (await this.#request("GET")).json();
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))) {
      throw new Error("the server did not list the queue as ids");
    }
    const taken: Taken[] = [];
    for (const id of ids as string[]) {
      const sealed = new Uint8Array(await (await this.#request("GET", id)).arrayBuffer());
      let bundle: Bundle;
      try {
        bundle = await this.#key.open(sealed);
      } catch (refused) {
        await this.#request("DELETE", id);
        taken.push({ id, refused });
        continue;
      }
      await keep(bundle);
      await this.#request("DELETE", id);
      taken.push({ id, bundle });
    }
    return taken;
  }

  async #request(method: string, id?: string): Promise<Response> {
    const url = new URL(this.#url);
    if (id !== undefined) url.pathname += `/${id}`;
    const response = await fetch(url, { method });
    if (!response.ok) throw new Error(`the test mailbox server answered ${response.status}`);
    return response;
  }
}
