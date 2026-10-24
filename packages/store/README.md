# @estoc/store

A store keeps what a user writes and what comes to them, on one device. Its
truth is objects: a record of each thing the user did, such as writing a
note or receiving a bundle, and the blobs those lead to. Secrets belong in
a keystore and the state of a running program in its own place, and neither
is an object.

A store holds two things.

- **Blobs by link**: any bytes, objects or not, kept under their link. A
  blob is added once and not changed, and is got by its link; the blobs are
  not listed. Blobs from anyone can be kept together: a link names one
  blob, so a blob someone sends can neither replace nor change one already
  kept.
- **What was written here**: the links of the objects the user wrote. It is
  the one thing in a store that is not a blob.

Every blob it holds comes with all that it leads to, and a write adds only
the blobs that what it writes here leads to.

```ts
import { json } from "@estoc/object";
import { MemoryBackend, Store } from "@estoc/store";

const store = new Store(json, new MemoryBackend());
const note = notes.encode("hello");
const signature = await signatures.sign(note, signer);
// `schemas` are all that the program writes to; the store keeps those named here.
await store.write({ mine: [note, signature], blobs: [signature.identity.bytes, ...schemas] });

for await (const link of store.mine()) …;       // note.link, signature.link
await store.read(signatures, signature.link);   // the signature, verified
```

## What is listed

Only what the user wrote is listed, and everything else is reached from it.
Anyone can send a bundle to a mailbox, and a bundle can carry an object of
any schema, so listing every blob of a schema would list an unsigned contact
that a stranger slipped in among the user's own contacts.

What comes from elsewhere comes in through something the user does, and that
is an object the user writes: a record of receiving a bundle, of taking a
card, of importing a file. The blobs come in the same write, unlisted, and
are read by following links from the record. A reader then knows they came
from elsewhere without any query having to say so. Something signed carries
its authority in its signature, and reads the same when reached by a link.

An unsigned object has no author to tell who wrote it, and what a bundle
leads to can include the user's own objects, as when someone replies to
them. So the store keeps the list itself rather than working it out.

## Writing

A write puts in a batch: objects written as the user's, under `mine`, and
the blobs that go with them, under `blobs`. Each is copied and hashed as it
comes in, so the store keeps blobs under the links it computed. What is
written as mine has to be an object of the store's encoding, or the whole
batch is refused.

Of the blobs, it keeps those that what is written as mine leads to, and
drops the rest. Nothing listed would reach them, so they could only wait to
be collected. A program can then give the schemas it writes to with every
write, and a bundle can carry blobs that its root does not lead to, without
either leaving anything behind.

A batch is refused whole, too, when what is written as mine leads to a blob
that neither the batch nor the store holds: the schema of an object, or a
blob its data links to. So the schemas of objects come with them unless the
store holds them already, and a bundle is taken in only with all that its
objects lead to, apart from what the receiver holds already.

Each blob goes in after the blobs it leads to, and before the links that
list it, so a write cut short leaves at worst blobs that nothing lists,
each with all it leads to.

There is no transaction that reads and then writes. Two devices that each
check that something is missing before writing it will both write it, and
when their stores are joined there are two. What has to come out as one is
written so that every device writes the same object, with the same link.

## Reading

`closure(link)` gathers the blob that `link` names and every blob it leads
to, all of which the store holds. A blob of the store's encoding leads to
the links that the encoding finds in it, the schema of an object among
them, and a blob of another encoding, such as an image, leads nowhere. The
closure of an object is what a bundle carrying it holds:

```ts
const files = writeBundle(signature, (await store.closure(signature.link)).values());
```

`read(semantics, link)` reads an object through a semantics, with its
closure as the blobs that the reading follows. A store is asynchronous,
since storage in a browser is, while a semantics reads from blobs at hand;
gathering the closure first leaves semantics as they are.

## Indexes

A store keeps no index. An application keeps its own, of the objects the
user writes: an `Index` says which schemas it reads and which rows each
object of them gives. A row is a key of strings and finite numbers,
compared one by one, a number before a string and a key before the longer
keys that start with it. The rows of an object depend on it alone, and an index is
the set of the rows its objects give, so the order they come in and how
often make no difference. What depends on what else is written, such as
whether something replaced an object, is worked out from the rows when
they are read.

```ts
import { scan, type Index } from "@estoc/store";

// Notes by tag, oldest first: a row for each tag of a note.
const byTag: Index<Json, [tag: string, at: number, note: Link<unknown>]> = {
  reads: [noteSchema],
  rows: ({ link, data }) => {
    const { tags, at } = data as { tags: string[]; at: number };
    return tags.map((tag) => [tag, at, link]);
  },
};

const rows = await scan(store, byTag);
for await (const [, at, note] of rows.range(["lunch"])) …;
```

`scan` goes through all that the user wrote, reads each object of a schema
the index reads, checks it against its schema and hands it to the index.
It passes over objects of other schemas, and what came from elsewhere
reaches an index only by following links from what the user wrote.
`range(prefix)` gives the rows whose keys start with `prefix`, in the
order of their keys. What does not fit in rows, such as a count, an
application keeps in a fold of its own, which then has to come to the same
whatever the order and however often an object comes. The rows are kept in
memory and worked out again on each scan.

## Backends

A store keeps its blobs and its list in a backend, which keeps bytes and
links as it is given them; the store does the hashing and decoding.
`MemoryBackend` keeps them in memory, for tests and for a program that
keeps nothing once it ends.
