# @estoc/lineage

A blob does not change, so a new version of something is a new blob, and
a lineage strings versions into a series. It is a chain of nodes, objects
of `@estoc/object`: each carries one item, the link of a version, and
names the node before it by its link.

```
Lineage Node  an Object written to the Lineage Node schema, with the fields
              "previous": <the link of the node before>, absent on the first,
              "item": <the link of a version>
```

## Lineages

- A lineage holds no authority. Anyone can build one: an author over
  their own versions, or a collector over versions of anyone. Nothing in
  it says who may append to it or which version is the latest, so there
  is no current head: which head to take is the program's to choose.
- An item is the same blob on a lineage as off it, and its link does not
  change. One item can be on several lineages, or twice on one, each time
  in a node of its own.
- The closure of a head is the whole history: every node before it and
  every item they carry. Holding a head, nothing in between is missing,
  and the order comes from the links, not from a clock. A store or a
  bundle carries closures, so whoever receives a head receives every
  version; whoever wants one version takes only that item.
- The first node is fixed by its item alone, so the lineages that start
  with one item share it, and it names their series. Two of them part
  where they fork.
- A node names one node before it, so lineages fork and do not merge.
- An identity of `@estoc/identity` stands behind a head by signing it, as
  it signs any object, and so behind the history before it. The signature
  gives the head no authority, and this package does not depend on
  identities.

Versions that someone has authority over are not a lineage. The versions
of an identity are signed by its root, each with the root's own `at`, and
a reader takes as current the one with the greatest `at` it has seen;
they stay as `@estoc/identity` writes them.

## Reading and building

`loadLineage(validator)` compiles the lineage node schema with the
validator the application picks and gives `Lineages`: `schema`,
`startingWith`, `read` and `selection`. A `Lineage` comes from them, so it
is a chain read back from its head to its first node, each node an object
of the node schema. It holds:

- `first`, `head`, and `nodes` from the first to the head.
- `items`, the links the nodes carry, in their order and one for each
  node, so an item carried twice is there twice.
- `blobs`, the bytes of the nodes and the blobs of the node schema: the
  closure of `head` but for the closures of the items, which the caller
  holds and sends along.
- `appending(item)`, the lineage with one node more, which carries `item`
  and names `head` as `previous`.

`startingWith(item)` gives the lineage of one node, which carries `item`.
Neither it nor `appending` writes anything, and the lineage appended to
stays as it is. `read(link, reader)` reads the lineage whose head `link`
names from `reader`, node by node, and not the items. It refuses one when
the reader gives no blob for a node on the way, or a blob that is not a
lineage node. A node names the one before it by its hash, so the chain
does not loop back, and it can be as long as it grows.

## In a store

A program writes a head as a record, with the lineage's `blobs` and the
closures of its items:

```ts
import { loadLineage } from "@estoc/lineage";
import { encodeObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { indexOver, scan } from "@estoc/store";

const lineages = await loadLineage(defaultValidator);
const draft = encodeObject(note, { text: "draft" });
const revised = encodeObject(note, { text: "revised" });
const final = encodeObject(note, { text: "final" });
const lineage = lineages.startingWith(draft).appending(revised).appending(final);
await store.write({
  records: [lineage.head],
  blobs: [...lineage.blobs, draft.bytes, revised.bytes, final.bytes, ...note.blobs],
});
```

`lineages.selection` is a `SelectionBySchema` of the node schema, as
`@estoc/object` has selections. It takes every node record, each as the
lineage it is the head of, read back to its first node. An index by
`first.link` keeps the heads of each series together, and one by
`head.data.item` says which lineages a version is on. Indexes and views
are the application's, and this package has none:

```ts
const bySeries = indexOver(lineages.selection, function* ({ first, head }) {
  yield [first.link, head.link] as const;
});
for await (const [, head] of (await scan(store, bySeries)).range([lineage.first.link])) {
  // every head of the series written as a record
}
```

The rows of a series hold every head written as a record, those appended
to since among them, and those on either side of a fork. Which of them to
show, such as those that no other head of the series extends, is worked
out by the application from the rows.
