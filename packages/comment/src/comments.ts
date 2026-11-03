import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchemaValidator,
  type Link,
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import type { Index, Rows, Store, View } from "@estoc/store";
import { type CommentData, commentSchema } from "./schema.ts";

export type CommentObject = EncodedObject<Json, CommentData>;

/** A comment, read from its object. */
export interface Comment {
  /** The link of the comment. */
  readonly link: Link<CommentObject>;
  /** The link of the blob it is on. */
  readonly on: Link<never>;
  readonly text: string;
  /** When, in milliseconds since the Unix epoch, by the clock of the device that wrote it. */
  readonly at: number;
}

/**
 * A comment as a row: the blob it is on, its `at` and its link. The rows of
 * the comments on one blob, in the order of their keys, go from the oldest
 * to the latest, and those written at the same time in the order of their
 * links.
 */
export type CommentRow = readonly [on: Link<never>, at: number, comment: Link<CommentObject>];

/** The comments in the rows of an index, by the blob each is on. */
export interface Commentary {
  /** The comments on the blob `on` names, in the order of their rows. */
  on(on: Link<unknown>): Promise<readonly Comment[]>;
  /** The blobs that comments are on, each once, in the order of their links. */
  commented(): AsyncIterable<Link<never>>;
}

export interface CommentOptions {
  /** The validator that the schema of a comment is compiled with. */
  readonly validator: JsonSchemaValidator;
  /** The time in milliseconds since the Unix epoch, `Date.now` unless given. */
  readonly clock?: () => number;
}

/**
 * Writing comments on blobs, and reading them by the blob each is on. A
 * comment is an object of `commentSchema` that the user writes, and links to
 * what it is on, so whatever holds a comment holds that too.
 */
export class Comments {
  /** The schema of a comment, compiled. */
  readonly schema: Schema<Json, CommentData>;
  /** An index of the comments the user writes, a row for each. */
  readonly index: Index<Json, CommentRow, CommentData>;
  /** The comments the user wrote, by the blob each is on, from the rows of `index`. */
  readonly view: View<Json, CommentRow, Commentary, CommentData>;
  readonly #clock: () => number;

  constructor(schema: Schema<Json, CommentData>, clock: () => number) {
    this.schema = schema;
    this.#clock = clock;
    this.index = { reads: [schema], rows: ({ link, data }) => [[data.on.$link, data.at, link]] };
    this.view = { index: this.index, read: (rows, reader) => this.commentary(rows, reader) };
  }

  /** The comment on `on` saying `text`, written at `at`, which is the clock's time unless given. */
  encode(on: Link<unknown>, text: string, at: number = this.#clock()): CommentObject {
    return encodeObject(this.schema, { on: { $link: on as Link<never> }, text, at });
  }

  /**
   * Writes the comment on `on` saying `text` to `store`, as the user's, with
   * its schema, and gives it back. The store may be a `PrivateStore`, for a
   * comment the user keeps to themselves. Like any write, it is refused with
   * a `RefusedBatch` when the store does not hold the blob `on` names, and
   * writes nothing. Saying the same again writes another comment, at
   * another time.
   */
  async write(store: Pick<Store, "write">, on: Link<unknown>, text: string): Promise<Comment> {
    const object = this.encode(on, text);
    await store.write({ mine: [object], blobs: [this.schema.bytes] });
    return commentOf(object);
  }

  /** Reads the comment that `link` names from `reader`, and refuses an object of any other schema. */
  async read(link: Link<unknown>, reader: Reader): Promise<Comment> {
    return commentOf(await readObject(reader, link, this.schema));
  }

  /** The comments in `rows`, the rows of `index`, each read from `reader`. */
  commentary(rows: Rows<CommentRow>, reader: Reader): Commentary {
    return {
      on: async (on) => {
        const comments: Comment[] = [];
        for await (const [, , link] of rows.range([on as Link<never>])) comments.push(await this.read(link, reader));
        return comments;
      },
      async *commented() {
        let last: Link<never> | undefined;
        for await (const [on] of rows.range([])) {
          if (on === last) continue;
          last = on;
          yield on;
        }
      },
    };
  }
}

function commentOf({ link, data }: CommentObject): Comment {
  return { link, on: data.on.$link, text: data.text, at: data.at };
}

/** Comments whose schema is compiled with `validator`, written at the time `clock` gives. */
export async function loadComments({ validator, clock = Date.now }: CommentOptions): Promise<Comments> {
  return new Comments(await encodeSchema<typeof commentSchema, Json, CommentData>(commentSchema, validator), clock);
}
