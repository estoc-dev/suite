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

Versions that someone has authority over are not a lineage. Identity
versions are signed by their root, each with the root's own `at`, and a
reader takes as current the one with the greatest `at` it has seen; they
stay as `@estoc/identity` writes them.

## Reading and building

`lineages` reads and builds lineages with the lineage node schema:
`schema`, `startingWith`, `read`, `selection` and `schemaLineageOf`. A
`Lineage` comes from them, so it is a chain read back from its head to its
first node, each node an object of the node schema. It holds:

- `first`, `head`, and `nodes` from the first to the head.
- `items`, the links the nodes carry, in their order and one for each
  node, so an item carried twice is there twice.
- `blobs`, the bytes of the nodes and the node schema: the closure of
  `head` but for the closures of the items, which the caller holds and
  sends along.
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
import { lineages } from "@estoc/lineage";
import { encodeObject } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, scan, selectedRecords } from "@estoc/store";

const firstDraft = encodeObject(note, { text: "first draft" });
const secondDraft = encodeObject(note, { text: "second draft" });
const finalDraft = encodeObject(note, { text: "final draft" });
const lineage = lineages.startingWith(firstDraft).appending(secondDraft).appending(finalDraft);
await store.write({
  records: [lineage.head],
  blobs: [...lineage.blobs, firstDraft.bytes, secondDraft.bytes, finalDraft.bytes, note.bytes],
});
```

`lineages.selection` is a `SelectionBySchema` of the node schema, as
`@estoc/object` has selections. It takes every node record, each as the
lineage it is the head of, read back to its first node. An index by
`first.link` keeps together the heads of each series written as records.
An index by each link in `items` finds the heads whose lineages hold a
version, and one by `head.data.item.$link` only the heads that carry it.
Indexes and views are the application's, and this package has none:

```ts
const headSchema = schema("Head", { series: link(), head: link() });
const bySeries = indexOver(selectedRecords(lineages.selection), headSchema, function* ({ first, head }) {
  yield { series: { $link: first.link }, head: { $link: head.link } };
}).orderedBy("series");
for await (const { data } of (await scan(store, bySeries)).range([{ $link: lineage.first.link }])) {
  // `data.head`: every head of the series written as a record
}
```

The rows of a series hold every head written as a record, those appended
to since among them, and those on either side of a fork. Which of them to
show, such as those that no other head of the series extends, is worked
out by the application from the rows.

## Schema lineages

A schema says what its data looks like, and not which version of a format
it is, so a new version of a format is a new schema with nothing in it
naming the one before. A schema lineage strings the versions into a
series: it is a lineage whose items are their schemas. Like any lineage,
it holds no authority. A program builds its own over the versions it
reads, and the author of the format can publish one; the same versions in
the same order give the same head, so the two can be compared.

`lineages.schemaLineageOf(versions)` takes the versions in their order,
each an `Implementation` of `@estoc/object` that reads an object of its
schema as the same `T`, their schemas of one encoding, and gives a
`SchemaLineage`:

- `lineage`, the lineage of the versions' schemas.
- `read(link, reader)`, which reads an object with the version whose
  schema it names, and refuses one of the schema of no version.
- `hasSchemaNamedBy(bytes)`, whether an object names the schema of a
  version, so that one of another schema can be left aside before `read`
  refuses it.
- `blobs`, the closure of the head: the lineage's `blobs` and those of
  every version's schema.
- `selection`, which takes every object of a version, each as its version
  reads it.

Objects of earlier versions stay as they were written, each read with its
own version, and new ones are written to the last. The first node is
fixed by the first version's schema, so it names the format's series, and
the lineage of a program that reads one version more extends that of one
that reads one less.

```ts
import type { Implementation, Json } from "@estoc/object";

type Note = { readonly title?: string; readonly text: string };

// noteV1 is a schema of { text }, and noteV2 a schema of { title, body }.
const v1: Implementation<Json, Note, { readonly text: string }> = {
  schema: noteV1,
  read: ({ data }) => ({ text: data.text }),
};
const v2: Implementation<Json, Note, { readonly title: string; readonly body: string }> = {
  schema: noteV2,
  read: ({ data }) => ({ title: data.title, text: data.body }),
};
const notes = lineages.schemaLineageOf([v1, v2]);
const note = await notes.read(link, store); // a Note, of either version
```

`SelectionBySchemaLineage` is to a schema lineage what `SelectionBySchema`
of `@estoc/object` is to a schema. One made with `itemOf` takes the
objects of every version, each as what `itemOf` gives of what its version
reads it as, and leaves out those it gives `undefined` for and the records
of other schemas; `notes.selection` takes each as it is read. Like any
selection other than by schema, it reads each record itself. An index of
`@estoc/store` over it holds the rows of every version:

```ts
import { SelectionBySchemaLineage } from "@estoc/lineage";
import { schema, string } from "@estoc/schema";
import { indexOver, selectedRecords } from "@estoc/store";

const textSchema = schema("Text", { text: string() });
const byText = indexOver(selectedRecords(notes.selection), textSchema, function* ({ text }) {
  yield { text };
}).orderedBy("text");
const titles = new SelectionBySchemaLineage(notes, ({ title }) => title); // the notes that have a title
```
