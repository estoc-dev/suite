import {
  DRAFT_2020_12,
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Implementation,
  Implementations,
  type Json,
  type JsonLink,
  type JsonSchema,
  type JsonSchemaValidator,
  type Link,
  linkSchema,
  type Reader,
  readObject,
  type Schema,
  SelectionBySchema,
  schemaOf,
} from "@estoc/object";
import { SchemaLineage } from "./schema-lineage.ts";

/**
 * The schema every lineage node is written to. A node carries one item, the
 * link of a version, and names the node before it as `previous`, which the
 * first node of a lineage does not have.
 *
 * - An item is the same blob on a lineage as off it, so one item can be on
 *   several lineages, or twice on one, each time in a node of its own.
 * - The first node is fixed by its item alone, so the lineages that start
 *   with one item share it, and it names their series.
 * - A node names one node before it, so lineages fork and do not merge.
 */
export const lineageNodeSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Lineage Node",
  type: "object",
  properties: { previous: linkSchema, item: linkSchema },
  required: ["item"],
  additionalProperties: false,
};

export type LineageNodeData = { readonly previous?: JsonLink<LineageNodeObject>; readonly item: JsonLink<unknown> };

export type LineageNodeObject = EncodedObject<Json, LineageNodeData>;

/**
 * A lineage read or built by `Lineages`, from its first node to its head.
 *
 * - Each node is an object of the lineage node schema, and each but the
 *   first names the one before it as `previous`.
 * - `items` are the links the nodes carry, in their order, one for each
 *   node, so an item carried twice is there twice.
 * - `blobs` are the bytes of the nodes and the blobs of the node schema: the
 *   closure of `head` but for the closures of the items, which the caller
 *   holds.
 */
export interface Lineage {
  readonly first: LineageNodeObject;
  readonly head: LineageNodeObject;
  readonly nodes: readonly LineageNodeObject[];
  readonly items: readonly Link<unknown>[];
  readonly blobs: readonly Uint8Array[];
  /** The lineage with one node more, which carries `item` and names `head` as `previous`. It writes nothing. */
  appending(item: { readonly link: Link<unknown> }): Lineage;
}

/**
 * Lineages, read and built with the lineage node schema.
 *
 * - Anyone builds a lineage, of their own items or anyone's, and nothing in
 *   it says who may append to it or which head is current: which head to
 *   take is the program's to choose.
 * - An identity stands behind a head by signing it, as it signs any object,
 *   and so behind the nodes and items before it.
 */
export class Lineages {
  readonly schema: Schema<Json, LineageNodeData>;
  /**
   * The selection of every lineage node, each as the lineage it is the head
   * of, read back to its first node.
   *
   * @throws where `read` does, when it reads a node.
   */
  readonly selection: SelectionBySchema<Json, Lineage, LineageNodeData>;

  constructor(schema: Schema<Json, LineageNodeData>) {
    this.schema = schema;
    this.selection = new SelectionBySchema(schema, (head, reader) => this.#readLineageEndingIn(head, reader));
  }

  /** The lineage of one node, which carries `item`. It writes nothing. */
  startingWith(item: { readonly link: Link<unknown> }): Lineage {
    return lineageOf(this.schema, [], encodeObject(this.schema, { item: { $link: item.link } }));
  }

  /**
   * The schema lineage of `versions`, in their order: the lineage of their
   * schemas, with each version read by its implementation. Their schemas are
   * of one encoding, in which an object names its schema. It writes nothing.
   *
   * @throws when two versions are of one schema.
   */
  schemaLineageOf<D, T>(versions: readonly [Implementation<D, T>, ...Implementation<D, T>[]]): SchemaLineage<T> {
    const [first, ...later] = versions;
    const { encoding } = first.schema;
    return new SchemaLineage(
      later.reduce((earlier, { schema }) => earlier.appending(schema), this.startingWith(first.schema)),
      versions.flatMap(({ schema }) => schema.blobs),
      new Implementations(encoding, versions),
      (record) => schemaOf(record, encoding),
    );
  }

  /**
   * The lineage whose head `link` names, read back to its first node from
   * `reader`. It reads the nodes and not the items.
   *
   * @throws when `reader` gives no blob for a node on the way, and where
   *   `readObject` throws for one that is not a lineage node.
   */
  async read(link: Link<LineageNodeObject>, reader: Reader): Promise<Lineage> {
    return this.#readLineageEndingIn(await readObject(reader, link, this.schema), reader);
  }

  async #readLineageEndingIn(head: LineageNodeObject, reader: Reader): Promise<Lineage> {
    // A node names the one before it by its hash, so the nodes do not loop back.
    const before: LineageNodeObject[] = [];
    for (let node = head; node.data.previous !== undefined; ) {
      node = await readObject(reader, node.data.previous.$link, this.schema);
      before.push(node);
    }
    return lineageOf(this.schema, before.reverse(), head);
  }
}

function lineageOf(
  schema: Schema<Json, LineageNodeData>,
  before: readonly LineageNodeObject[],
  head: LineageNodeObject,
): Lineage {
  const nodes = [...before, head];
  return {
    first: before[0] ?? head,
    head,
    nodes,
    items: nodes.map((node) => node.data.item.$link),
    blobs: [...nodes.map((node) => node.bytes), ...schema.blobs],
    appending: (item) =>
      lineageOf(schema, nodes, encodeObject(schema, { previous: { $link: head.link }, item: { $link: item.link } })),
  };
}

/** The lineage node schema compiled by `validator`, as what reads and builds lineages. */
export async function loadLineage(validator: JsonSchemaValidator): Promise<Lineages> {
  return new Lineages(await encodeSchema(lineageNodeSchema, validator));
}
