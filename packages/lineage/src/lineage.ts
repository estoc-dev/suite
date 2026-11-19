import {
  type EncodedObject,
  encodeObject,
  type Implementation,
  Implementations,
  type Link,
  LinkValue,
  type Reader,
  readObject,
  SelectionBySchema,
} from "@estoc/object";
import { type DataOf, link, optional, schema } from "@estoc/schema";
import { SchemaLineage } from "./schema-lineage.ts";

export const lineageNodeSchema = schema("Lineage Node", {
  previous: optional(link<LineageNodeObject>()),
  item: link(),
});

export type LineageNodeData = DataOf<typeof lineageNodeSchema>;

export interface LineageNodeObject extends EncodedObject<LineageNodeData> {}

export interface Lineage {
  readonly first: LineageNodeObject;
  readonly head: LineageNodeObject;
  readonly nodes: readonly LineageNodeObject[];
  readonly items: readonly Link<unknown>[];
  readonly blobs: readonly Uint8Array[];
  appending(item: { readonly link: Link<unknown> }): Lineage;
}

/**
 * Anyone builds a lineage, of their own items or anyone's, and nothing in it says who may append to
 * it or which head is current: which head to take is the program's to choose.
 */
export class Lineages {
  readonly schema = lineageNodeSchema;
  readonly selection: SelectionBySchema<Lineage, LineageNodeData> = new SelectionBySchema(
    lineageNodeSchema,
    (head, reader) => this.#readLineageEndingIn(head, reader),
  );

  startingWith(item: { readonly link: Link<unknown> }): Lineage {
    return lineageOf([], encodeObject(lineageNodeSchema, { item: new LinkValue(item.link) }));
  }

  schemaLineageOf<T>(versions: readonly [Implementation<T>, ...Implementation<T>[]]): SchemaLineage<T> {
    const [first, ...later] = versions;
    return new SchemaLineage(
      later.reduce((earlier, { schema }) => earlier.appending(schema), this.startingWith(first.schema)),
      versions.flatMap(({ schema }) => schema.blobs),
      new Implementations(versions),
    );
  }

  async read(link: Link<LineageNodeObject>, reader: Reader): Promise<Lineage> {
    return this.#readLineageEndingIn(await readObject(reader, link, this.schema), reader);
  }

  async #readLineageEndingIn(head: LineageNodeObject, reader: Reader): Promise<Lineage> {
    // A node names the one before it by its hash, so the nodes do not loop back.
    const before: LineageNodeObject[] = [];
    for (let node = head; node.data.previous !== undefined; ) {
      node = await readObject(reader, node.data.previous.link, this.schema);
      before.push(node);
    }
    return lineageOf(before.reverse(), head);
  }
}

function lineageOf(before: readonly LineageNodeObject[], head: LineageNodeObject): Lineage {
  const nodes = [...before, head];
  return {
    first: before[0] ?? head,
    head,
    nodes,
    items: nodes.map((node) => node.data.item.link),
    blobs: [...nodes.map((node) => node.bytes), ...lineageNodeSchema.blobs],
    appending: (item) =>
      lineageOf(
        nodes,
        encodeObject(lineageNodeSchema, { previous: new LinkValue(head.link), item: new LinkValue(item.link) }),
      ),
  };
}

export const lineages = new Lineages();
